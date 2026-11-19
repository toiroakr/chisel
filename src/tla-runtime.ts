/** The runtime shape generated from a supported TLA+ machine module. */
export interface TlaMachine<State, Command> {
  readonly kind: "tla-machine";
  readonly name: string;
  readonly initial: readonly State[];
  readonly commands: readonly Command[];
  transition(state: State, command: Command, options?: { readonly maxCommands?: number }): {
    readonly state: State;
    readonly steps: readonly { readonly before: State; readonly after: State; readonly command: Command }[];
  };
}

/** TLA+ value equality is structural for records and sequences. */
export function tlaEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return Number.isSafeInteger(left) && left === right;
  if (typeof left === "bigint" && typeof right === "number" && Number.isSafeInteger(right)) return left === BigInt(right);
  if (typeof right === "bigint" && typeof left === "number" && Number.isSafeInteger(left)) return BigInt(left) === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => tlaEqual(item, right[index]));
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const a = Object.keys(left), b = Object.keys(right);
    return a.length === b.length && a.every(key => Object.hasOwn(right, key) && tlaEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

export function tlaInRange(value: unknown, min: number, max: number): boolean {
  if (typeof value === "bigint") return value >= BigInt(min) && value <= BigInt(max);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function tlaNumber(value: unknown): unknown {
  if (typeof value === "bigint") {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new RangeError("TLA+ integer cannot be represented as a safe JavaScript number");
    return result;
  }
  if (Array.isArray(value)) return value.map(tlaNumber);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, tlaNumber(child)]));
  return value;
}

export function tlaExcept(value: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, path[0]!)) throw new TypeError("TLA+ EXCEPT path does not exist");
  const [head, ...tail] = path;
  return { ...value, [head!]: tlaExcept((value as Record<string, unknown>)[head!], tail, replacement) };
}

export function createTlaMachine<State, Command>(definition: {
  readonly name: string;
  readonly initial: readonly State[];
  readonly commands: readonly Command[];
  readonly acceptsState: (value: unknown) => value is State;
  readonly step: (state: State, command: Command) => { readonly state: State; readonly commands?: readonly Command[] };
}): TlaMachine<State, Command> {
  const acceptsCommand = (value: unknown): value is Command => definition.commands.some(command => tlaEqual(command, value));
  const validateState = (value: unknown): State => {
    if (!definition.acceptsState(value)) throw new TypeError(`Machine ${definition.name} produced a state outside StateDomain`);
    return value;
  };
  if (definition.initial.length === 0) throw new TypeError(`Machine ${definition.name} has no initial state`);
  definition.initial.forEach(validateState);
  return {
    kind: "tla-machine", name: definition.name, initial: definition.initial, commands: definition.commands,
    transition(state, command, options = {}) {
      const limit = options.maxCommands ?? 1000;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("maxCommands must be a positive safe integer");
      let current = validateState(state);
      const pending: Command[] = [command];
      const steps: { before: State; after: State; command: Command }[] = [];
      while (pending.length) {
        if (steps.length >= limit) throw new RangeError(`Machine ${definition.name} exceeded maxCommands (${limit})`);
        const nextCommand = pending.shift()!;
        if (!acceptsCommand(nextCommand)) throw new TypeError(`Machine ${definition.name} received a command outside CommandDomain`);
        const output = tlaNumber(definition.step(current, nextCommand)) as { state: State; commands?: readonly Command[] };
        if (output === null || typeof output !== "object" || !Array.isArray(output.commands)) {
          throw new TypeError(`Machine ${definition.name} Step must return state and commands`);
        }
        const next = validateState(output.state);
        for (const emitted of output.commands) {
          if (!acceptsCommand(emitted)) throw new TypeError(`Machine ${definition.name} emitted a command outside CommandDomain`);
        }
        steps.push({ before: current, after: next, command: nextCommand });
        current = next;
        pending.push(...output.commands);
      }
      return { state: current, steps };
    },
  };
}
