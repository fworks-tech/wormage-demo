/** UTF-8 byte length of a string, for upload budgets. */
export function byteSize(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length;
}
