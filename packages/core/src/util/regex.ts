// A linear-time matcher for the `matches` condition.
//
// Patterns are JavaScript regular expressions with the `u` flag, minus backreferences and
// lookaround (matchesPatternProblem rejects those at parse time). What is left fits a Thompson
// automaton, simulated here Pike-style: time is O(pattern x input) and nothing backtracks.
//
// Single-character atoms (literals, `.`, escapes such as \d or \p{L}, and classes) are tested with
// the platform RegExp anchored to exactly one code point, so class syntax matches JavaScript exactly.
// That test is constant time per character. Structure (alternation, groups, quantifiers, anchors)
// runs on the automaton below, never on the backtracking engine.

import { matchesPatternProblem } from "../contracts/policy.js";

type Node =
  | { t: "char"; test: (ch: string) => boolean }
  | { t: "assert"; kind: "start" | "end" | "word" | "nonword" }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "repeat"; node: Node; min: number; max: number };

type Instr =
  | { op: "char"; test: (ch: string) => boolean }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "assert"; kind: "start" | "end" | "word" | "nonword" }
  | { op: "match" };

/** Largest compiled program. Counted repetition expands, so this bounds the work per character. */
export const MAX_PROGRAM_SIZE = 20_000;

class PatternError extends Error {}

function atomTest(source: string): (ch: string) => boolean {
  // Anchored to one code point, so the platform engine cannot backtrack over input.
  const re = new RegExp(`^(?:${source})$`, "u");
  return (ch) => re.test(ch);
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw new PatternError(`unexpected ${this.src[this.i]}`);
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private alt(): Node {
    const options = [this.seq()];
    while (this.peek() === "|") {
      this.i++;
      options.push(this.seq());
    }
    return options.length === 1 ? (options[0] as Node) : { t: "alt", options };
  }

  private seq(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") break;
      items.push(this.quantified());
    }
    return { t: "seq", items };
  }

  private quantified(): Node {
    const atom = this.atom();
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (m === null) throw new PatternError("bad quantifier");
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      this.i += m[0].length - 1;
    } else return atom;
    this.i++;
    if (this.peek() === "?") this.i++; // lazy and greedy match the same inputs for a yes/no test
    return { t: "repeat", node: atom, min, max };
  }

  private atom(): Node {
    const c = this.peek();
    if (c === "(") {
      this.i++;
      if (this.src.startsWith("?:", this.i)) this.i += 2;
      else if (this.src.startsWith("?<", this.i)) {
        const close = this.src.indexOf(">", this.i);
        this.i = close + 1;
      }
      const inner = this.alt();
      if (this.peek() !== ")") throw new PatternError("missing )");
      this.i++;
      return inner;
    }
    if (c === "^") {
      this.i++;
      return { t: "assert", kind: "start" };
    }
    if (c === "$") {
      this.i++;
      return { t: "assert", kind: "end" };
    }
    if (c === "[") return { t: "char", test: atomTest(this.classSource()) };
    if (c === "\\") {
      const next = this.src[this.i + 1];
      if (next === "b" || next === "B") {
        this.i += 2;
        return { t: "assert", kind: next === "b" ? "word" : "nonword" };
      }
      return { t: "char", test: atomTest(this.escapeSource()) };
    }
    // A literal code point (surrogate pairs stay together).
    const cp = this.src.codePointAt(this.i) ?? 0;
    const ch = String.fromCodePoint(cp);
    this.i += ch.length;
    if (ch === ".") return { t: "char", test: atomTest(".") };
    return { t: "char", test: (x) => x === ch };
  }

  private escapeSource(): string {
    const start = this.i;
    this.i++; // the backslash
    const c = this.src[this.i];
    if (c === "u" && this.src[this.i + 1] === "{") this.i = this.src.indexOf("}", this.i) + 1;
    else if (c === "u") this.i += 5;
    else if (c === "x") this.i += 3;
    else if (c === "c") this.i += 2;
    else if ((c === "p" || c === "P") && this.src[this.i + 1] === "{") this.i = this.src.indexOf("}", this.i) + 1;
    else this.i += String.fromCodePoint(this.src.codePointAt(this.i) ?? 0).length;
    return this.src.slice(start, this.i);
  }

  private classSource(): string {
    const start = this.i;
    this.i++; // [
    while (this.i < this.src.length && this.src[this.i] !== "]") {
      if (this.src[this.i] === "\\") this.escapeSource();
      else this.i++;
    }
    this.i++; // ]
    return this.src.slice(start, this.i);
  }
}

class Compiler {
  readonly prog: Instr[] = [];

  private emit(instr: Instr): number {
    if (this.prog.length >= MAX_PROGRAM_SIZE) throw new PatternError("pattern too large");
    this.prog.push(instr);
    return this.prog.length - 1;
  }

  compile(node: Node): void {
    switch (node.t) {
      case "char":
        this.emit({ op: "char", test: node.test });
        return;
      case "assert":
        this.emit({ op: "assert", kind: node.kind });
        return;
      case "seq":
        for (const item of node.items) this.compile(item);
        return;
      case "alt": {
        const jumps: number[] = [];
        node.options.forEach((option, k) => {
          if (k < node.options.length - 1) {
            const split = this.emit({ op: "split", x: 0, y: 0 });
            this.prog[split] = { op: "split", x: split + 1, y: 0 };
            this.compile(option);
            jumps.push(this.emit({ op: "jmp", x: 0 }));
            this.prog[split] = { op: "split", x: split + 1, y: this.prog.length };
          } else this.compile(option);
        });
        for (const j of jumps) this.prog[j] = { op: "jmp", x: this.prog.length };
        return;
      }
      case "repeat": {
        for (let k = 0; k < node.min; k++) this.compile(node.node);
        if (node.max === Infinity) {
          const split = this.emit({ op: "split", x: 0, y: 0 });
          this.compile(node.node);
          this.emit({ op: "jmp", x: split });
          this.prog[split] = { op: "split", x: split + 1, y: this.prog.length };
          return;
        }
        const splits: number[] = [];
        for (let k = node.min; k < node.max; k++) {
          splits.push(this.emit({ op: "split", x: 0, y: 0 }));
          this.compile(node.node);
        }
        for (const s of splits) this.prog[s] = { op: "split", x: s + 1, y: this.prog.length };
        return;
      }
    }
  }
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /^[A-Za-z0-9_]$/.test(ch);

function run(prog: readonly Instr[], input: string): boolean {
  const chars = Array.from(input);
  const n = chars.length;
  const seenAt = new Array<number>(prog.length).fill(-1);
  let matched = false;

  // Follows epsilon edges with an explicit stack, so a large program cannot overflow the call stack.
  const add = (list: number[], start: number, pos: number): void => {
    const stack = [start];
    while (stack.length > 0 && !matched) {
      const pc = stack.pop() as number;
      if (seenAt[pc] === pos) continue;
      seenAt[pc] = pos;
      const instr = prog[pc] as Instr;
      if (instr.op === "jmp") stack.push(instr.x);
      else if (instr.op === "split") stack.push(instr.y, instr.x);
      else if (instr.op === "match") matched = true;
      else if (instr.op === "char") list.push(pc);
      else {
        const holds =
          instr.kind === "start"
            ? pos === 0
            : instr.kind === "end"
              ? pos === n
              : (isWordChar(chars[pos - 1]) !== isWordChar(chars[pos])) === (instr.kind === "word");
        if (holds) stack.push(pc + 1);
      }
    }
  };

  let current: number[] = [];
  for (let pos = 0; pos <= n; pos++) {
    add(current, 0, pos); // unanchored search: a new thread may start at every position
    if (matched) return true;
    if (pos === n) break;
    const next: number[] = [];
    const ch = chars[pos] as string;
    for (const pc of current) {
      const instr = prog[pc] as Instr & { op: "char" };
      if (instr.test(ch)) add(next, pc + 1, pos + 1);
      if (matched) return true;
    }
    current = next;
  }
  return matched;
}

const cache = new Map<string, readonly Instr[] | null>();

function program(pattern: string): readonly Instr[] | null {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  let prog: readonly Instr[] | null = null;
  if (matchesPatternProblem(pattern) === null) {
    try {
      const compiler = new Compiler();
      compiler.compile(new Parser(pattern).parse());
      compiler.prog.push({ op: "match" });
      prog = compiler.prog;
    } catch {
      prog = null;
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(pattern, prog);
  return prog;
}

/**
 * True when `pattern` matches somewhere in `input`, like RegExp.prototype.test with the `u` flag.
 * A pattern outside the supported subset never matches.
 */
export function linearMatch(pattern: string, input: string): boolean {
  const prog = program(pattern);
  return prog === null ? false : run(prog, input);
}

/** True when core can run `pattern` on its linear-time engine. */
export function isSupportedPattern(pattern: string): boolean {
  return program(pattern) !== null;
}
