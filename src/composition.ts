import type { AnyBehavior, AnyImplementation, Behavior, Implementation } from "./behavior.js";
import { SpecificationError } from "./behavior.js";
import type { Requirements } from "./dependency.js";
import type { AnyVariantsSchema, VariantsSchema, VariantTable } from "./schema.js";
import { isVariantsSchema, variants } from "./schema.js";

type VariantsOf<S> = S extends VariantsSchema<any, infer Variants> ? Variants : never;
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

type ComposedResult<First extends AnyBehavior, Second extends AnyBehavior> = VariantsSchema<
  DiscriminantOf<First["result"]>,
  Pick<VariantsOf<First["result"]>, Departing<First, Second> & keyof VariantsOf<First["result"]>> &
    VariantsOf<Second["result"]>
>;

type ComposedEffects<First extends AnyBehavior, Second extends AnyBehavior> = VariantsSchema<
  DiscriminantOf<First["effects"]>,
  VariantsOf<First["effects"]> & VariantsOf<Second["effects"]>
>;

export type Composition<First extends AnyBehavior, Second extends AnyBehavior> = Behavior<
  First["input"],
  ComposedResult<First, Second>,
  ComposedEffects<First, Second>,
  RequiresOf<First> & RequiresOf<Second>
> & {
  readonly stages: readonly [AnyBehavior, AnyBehavior];
  readonly departed: readonly Departing<First, Second>[];
};

export function compose<const First extends AnyBehavior, const Second extends AnyBehavior>(
  first: First,
  second: Second,
  options: { readonly name?: string } = {},
): Composition<First, Second> {
  const firstResult = sumResult(first);
  const secondResult = sumResult(second);
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
  const result = variants(firstResult.discriminant, {
    ...pick(firstResult.variants, departing),
    ...secondResult.variants,
  });
  return {
    kind: "behavior",
    name: options.name ?? `${first.name} >-> ${second.name}`,
    input: first.input,
    result,
    effects: mergedEffects(first, second),
    dependsOn: [...new Set([...first.dependsOn, ...second.dependsOn])],
    requires: mergedRequires(first, second),
    ensures: [],
    stages: [first, second],
    departed: [...departing, ...departedOf(second)],
  } as unknown as Composition<First, Second>;
}

export function implementComposition<B extends AnyBehavior & { readonly stages: readonly [AnyBehavior, AnyBehavior] }>(
  definition: B,
  first: Implementation<B["stages"][0]> | AnyImplementation,
  second: Implementation<B["stages"][1]> | AnyImplementation,
): Implementation<B> {
  const [firstStage, secondStage] = definition.stages;
  if (first.behavior !== firstStage || second.behavior !== secondStage) {
    throw new SpecificationError(`The implementations do not implement the stages of ${definition.name}`);
  }
  return {
    kind: "implementation",
    behavior: definition,
    cases: {} as Implementation<B>["cases"],
    controls: { ...first.controls, ...second.controls } as Implementation<B>["controls"],
    stages: [first, second],
  };
}

export function isComposition(
  definition: AnyBehavior,
): definition is AnyBehavior & { readonly stages: readonly [AnyBehavior, AnyBehavior] } {
  return (definition as { readonly stages?: unknown }).stages !== undefined;
}

function departedOf(definition: AnyBehavior): readonly string[] {
  return (definition as { readonly departed?: readonly string[] }).departed ?? [];
}

function sumResult(definition: AnyBehavior): AnyVariantsSchema {
  if (!isVariantsSchema(definition.result)) {
    throw new SpecificationError(`${definition.name} does not answer a sum, so nothing can flow from it`);
  }
  return definition.result;
}

function pick(variants: VariantTable, tags: readonly string[]): VariantTable {
  return Object.fromEntries(tags.map(tag => [tag, variants[tag]!]));
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

