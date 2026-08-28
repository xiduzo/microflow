/** Shared formatting for the benchmark scripts. */

export function header(title: string): void {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(72)}`);
}

export function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}\n`);
}

export function formatRow(cells: string[], widths: number[]): string {
  return cells.map((cell, i) => cell.padEnd(widths[i] ?? 12)).join("  ");
}

/** Median of `runs` timed executions, in milliseconds. */
export function timeMedian(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}
