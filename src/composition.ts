import type { AnyBehavior, AnyImplementation, Behavior, Implementation } from "./behavior.js";
import { SpecificationError } from "./behavior.js";
import type { Requirements } from "./dependency.js";
import type { AnyVariantsSchema, VariantsSchema, VariantTable } from "./schema.js";
import { isVariantsSchema, variants } from "./schema.js";

type Stages = readonly [AnyBehavior, AnyBehavior, ...AnyBehavior[]];

type VariantsOf<S> = S extends VariantsSchema<any, infer Table> ? Table : never;
type DiscriminantOf<S> = S extends VariantsSchema<infer Discriminant, any> ? Discriminant : never;
type DepartedOf<B> = B extends { readonly departed: readonly (infer Tag extends string)[] }
  ? Tag
  : never;
type RequiresOf<B> = B extends { readonly requires: infer Requires } ? Requires : never;

type Flowing<First extends AnyBehavior, Second extends AnyBehavior> = Exclude<
  keyof VariantsOf<First["result"]> & string,
  DepartedOf<First>
> &
  keyof VariantsOf<Second["input"]>;

type Departing<First extends AnyBehavior, Second extends AnyBehavior> =
  | DepartedOf<First>
  | DepartedOf<Second>
  | Exclude<keyof VariantsOf<First["result"]> & string, Flowing<First, Second>>;

type Joined<First extends AnyBehavior, Second extends AnyBehavior> = Behavior<
  First["input"],
  VariantsSchema<
    DiscriminantOf<First["result"]>,
    Pick<VariantsOf<First["result"]>, Departing<First, Second> & keyof VariantsOf<First["result"]>> &
      VariantsOf<Second["result"]>
  >,
  VariantsSchema<
    DiscriminantOf<First["effects"]>,
    VariantsOf<First["effects"]> & VariantsOf<Second["effects"]>
  >,
  RequiresOf<First> & RequiresOf<Second>
> & { readonly departed: readonly Departing<First, Second>[] };

type Folded<Acc extends AnyBehavior, Rest extends readonly AnyBehavior[]> = Rest extends readonly [
  infer Next extends AnyBehavior,
  ...infer Others extends readonly AnyBehavior[],
]
  ? Folded<Joined<Acc, Next>, Others>
  : Acc;

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : [];

export type Composition<S extends Stages> = Folded<S[0], Tail<S>> & {
  readonly stages: S;
};

export type StageImplementations<S extends readonly AnyBehavior[]> = {
  readonly [K in keyof S]: Implementation<S[K]>;
};

interface Joint {
  readonly pair: readonly [AnyBehavior, AnyBehavior];
  readonly departed: readonly string[];
}

export function compose<const S extends Stages>(name: string, ...stages: S): Composition<S> {
  const [head, ...rest] = stages;
  const chain: (AnyBehavior & Joint)[] = [];
  let joined: AnyBehavior = head;
  rest.forEach((next, index) => {
    joined = join(joined, next, index === rest.length - 1 ? name : `${joined.name} >-> ${next.name}`);
    chain.push(joined as AnyBehavior & Joint);
  });
  return { ...joined, stages, chain } as unknown as Composition<S>;
}

export function isComposition(
  definition: AnyBehavior,
): definition is AnyBehavior & { readonly stages: Stages } {
  return (definition as { readonly stages?: unknown }).stages !== undefined;
}

export function implementStages(
  definition: AnyBehavior & { readonly stages: Stages },
  implementations: readonly AnyImplementation[],
): AnyImplementation {
  const { stages } = definition;
  const chain = (definition as unknown as { readonly chain: readonly AnyBehavior[] }).chain;
  if (
    implementations.length !== stages.length ||
    implementations.some((implementation, index) => implementation.behavior !== stages[index])
  ) {
    throw new SpecificationError(`The implementations do not implement the stages of ${definition.name}`);
  }
  const [first, ...rest] = implementations as [AnyImplementation, ...AnyImplementation[]];
  let joined = first;
  rest.forEach((next, index) => {
    joined = {
      kind: "implementation",
      behavior: index === rest.length - 1 ? definition : chain[index]!,
      cases: {} as AnyImplementation["cases"],
      controls: { ...joined.controls, ...next.controls },
      pipeline: [joined, next],
    };
  });
  return joined;
}

function join(first: AnyBehavior, second: AnyBehavior, name: string): AnyBehavior & Joint {
  const firstResult = variantsResult(first);
  const secondResult = variantsResult(second);
  if (
    second.input.discriminant !== firstResult.discriminant ||
    secondResult.discriminant !== firstResult.discriminant
  ) {
    throw new SpecificationError(
      `${first.name} and ${second.name} do not name their cases by one discriminant`,
    );
  }
  const earlier = departedOf(first);
  const mainline = firstResult.variantTags.filter(tag => !earlier.includes(tag));
  const flowing = mainline.filter(tag => second.input.variantTags.includes(tag));
  if (flowing.length === 0) {
    throw new SpecificationError(`${second.name} receives none of the cases ${first.name} answers`);
  }
  const departing = firstResult.variantTags.filter(tag => !flowing.includes(tag));
  const colliding = departing.find(tag => secondResult.variantTags.includes(tag));
  if (colliding !== undefined) {
    throw new SpecificationError(
      `${colliding} departs ${first.name} and is answered by ${second.name}; a value cannot say which rail it is on`,
    );
  }
  return {
    kind: "behavior",
    name,
    input: first.input,
    result: variants(firstResult.discriminant, {
      ...pick(firstResult.variants, departing),
      ...secondResult.variants,
    }),
    effects: mergedEffects(first, second),
    dependsOn: [...new Set([...first.dependsOn, ...second.dependsOn])],
    requires: mergedRequires(first, second),
    ensures: [],
    pair: [first, second],
    departed: [...departing, ...departedOf(second)],
  };
}

function departedOf(definition: AnyBehavior): readonly string[] {
  return (definition as { readonly departed?: readonly string[] }).departed ?? [];
}

function variantsResult(definition: AnyBehavior): AnyVariantsSchema {
  if (!isVariantsSchema(definition.result)) {
    throw new SpecificationError(`${definition.name} does not answer variants, so nothing can flow from it`);
  }
  return definition.result;
}

function pick(table: VariantTable, tags: readonly string[]): VariantTable {
  return Object.fromEntries(tags.map(tag => [tag, table[tag]!]));
}

function mergedEffects(first: AnyBehavior, second: AnyBehavior): AnyVariantsSchema {
  const [left, right] = [first.effects, second.effects];
  if (right.variantTags.length === 0) {
    return left;
  }
  if (left.variantTags.length === 0) {
    return right;
  }
  if (left.discriminant !== right.discriminant) {
    throw new SpecificationError(
      `${first.name} and ${second.name} do not name their effects by one discriminant`,
    );
  }
  const clash = left.variantTags.find(
    tag => right.variantTags.includes(tag) && left.variants[tag] !== right.variants[tag],
  );
  if (clash !== undefined) {
    throw new SpecificationError(`${first.name} and ${second.name} declare the effect ${clash} apart`);
  }
  return variants(left.discriminant, { ...left.variants, ...right.variants });
}

function mergedRequires(first: AnyBehavior, second: AnyBehavior): Requirements {
  const clash = Object.keys(second.requires).find(
    name => name in first.requires && first.requires[name] !== second.requires[name],
  );
  if (clash !== undefined) {
    throw new SpecificationError(`${first.name} and ${second.name} require ${clash} apart`);
  }
  return { ...first.requires, ...second.requires };
}
