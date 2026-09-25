import type { AnyBehavior, AnyImplementation, Behavior, Implementation } from "./behavior.js";
import { SpecificationError } from "./behavior.js";
import type { Requirements } from "./dependency.js";
import type {
  AnySchema,
  AnyVariantsSchema,
  ArraySchema,
  LiteralSchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
  RecordSchema,
  VariantsSchema,
  VariantTable,
} from "./schema.js";
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

export type Composition<S extends readonly AnyBehavior[]> = S extends readonly [
  infer Head extends AnyBehavior,
  ...infer Rest extends readonly AnyBehavior[],
]
  ? Folded<Head, Rest> & { readonly stages: S }
  : never;

type Implementations = readonly [AnyImplementation, AnyImplementation, ...AnyImplementation[]];

type BehaviorsOf<I extends readonly AnyImplementation[]> = {
  readonly [K in keyof I]: I[K] extends Implementation<infer B> ? B : never;
};

interface Joint {
  readonly pair: readonly [AnyBehavior, AnyBehavior];
  readonly departed: readonly string[];
}

export function compose<const I extends Implementations>(
  name: string,
  implementations: I,
): readonly [
  Composition<BehaviorsOf<I>>,
  Implementation<Composition<BehaviorsOf<I>>>,
] {
  if (implementations.length < 2) {
    throw new SpecificationError(`${name} needs two stages or more`);
  }
  const [first, ...rest] = implementations as unknown as [AnyImplementation, ...AnyImplementation[]];
  let behavior: AnyBehavior = first.behavior;
  let implementation: AnyImplementation = first;
  rest.forEach((next, index) => {
    behavior = join(
      behavior,
      next.behavior,
      index === rest.length - 1 ? name : `${behavior.name} >-> ${next.behavior.name}`,
    );
    implementation = {
      kind: "implementation",
      behavior,
      cases: {} as AnyImplementation["cases"],
      controls: { ...implementation.controls, ...next.controls },
      pipeline: [implementation, next],
    };
  });
  const composition = {
    ...behavior,
    stages: implementations.map(item => item.behavior),
  } as unknown as Composition<BehaviorsOf<I>>;
  return [
    composition,
    { ...implementation, behavior: composition } as unknown as Implementation<
      Composition<BehaviorsOf<I>>
    >,
  ];
}

export function isComposition(
  definition: AnyBehavior,
): definition is AnyBehavior & { readonly stages: Stages } {
  return (definition as { readonly stages?: unknown }).stages !== undefined;
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
  for (const tag of flowing) {
    const undeclared = undeclaredPath(
      firstResult.variants[tag]!,
      second.input.variants[tag]!,
      `@${tag}`,
      firstResult.discriminant,
    );
    if (undeclared !== undefined) {
      throw new SpecificationError(
        `${first.name} answers ${undeclared}, which ${second.name} does not declare`,
      );
    }
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
    requires: mergedRequires(first, second),
    ensures: [],
    pair: [first, second],
    departed: [...departing, ...departedOf(second)],
  };
}

function undeclaredPath(
  answered: AnySchema,
  taken: AnySchema,
  path: string,
  discriminant?: string,
): string | undefined {
  if (answered.kind === "optional") {
    return undeclaredPath((answered as OptionalSchema<unknown>).schema as AnySchema, taken, `${path}?`);
  }
  if (taken.kind === "optional") {
    return undeclaredPath(answered, (taken as OptionalSchema<unknown>).schema as AnySchema, path);
  }
  if (answered.kind === "object" && taken.kind === "object") {
    const takenShape = (taken as ObjectSchema<ObjectShape>).shape;
    for (const [key, field] of Object.entries((answered as ObjectSchema<ObjectShape>).shape)) {
      if (key === discriminant && !Object.hasOwn(takenShape, key)) {
        continue;
      }
      const found = Object.hasOwn(takenShape, key)
        ? undeclaredPath(field, takenShape[key]!, `${path}.${key}`)
        : `${path}.${key}`;
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (answered.kind === "object" && taken.kind === "record") {
    const value = (taken as RecordSchema<unknown>).value as AnySchema;
    for (const [key, field] of Object.entries((answered as ObjectSchema<ObjectShape>).shape)) {
      const found = undeclaredPath(field, value, `${path}.${key}`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (answered.kind === "array" && taken.kind === "array") {
    return undeclaredPath(
      (answered as ArraySchema<unknown>).element as AnySchema,
      (taken as ArraySchema<unknown>).element as AnySchema,
      `${path}[]`,
    );
  }
  if (answered.kind === "record" && taken.kind === "record") {
    return undeclaredPath(
      (answered as RecordSchema<unknown>).value as AnySchema,
      (taken as RecordSchema<unknown>).value as AnySchema,
      `${path}{}`,
    );
  }
  if (answered.kind === "object" && isVariantsSchema(taken)) {
    const named = (answered as ObjectSchema<ObjectShape>).shape[taken.discriminant];
    if (named?.kind !== "literal") {
      return undefined;
    }
    const tag = String((named as LiteralSchema<string>).value);
    return taken.variantTags.includes(tag)
      ? undeclaredPath(answered, taken.variants[tag], path, taken.discriminant)
      : `${path}@${tag}`;
  }
  if (isVariantsSchema(answered) && taken.kind === "object") {
    if (!Object.hasOwn((taken as ObjectSchema<ObjectShape>).shape, answered.discriminant)) {
      return `${path}.${answered.discriminant}`;
    }
    for (const tag of answered.variantTags) {
      const found = undeclaredPath(answered.variants[tag], taken, `${path}@${tag}`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (isVariantsSchema(answered) && isVariantsSchema(taken)) {
    for (const tag of answered.variantTags) {
      if (!taken.variantTags.includes(tag)) {
        return `${path}@${tag}`;
      }
      const found = undeclaredPath(
        answered.variants[tag],
        taken.variants[tag],
        `${path}@${tag}`,
        answered.discriminant,
      );
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
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
