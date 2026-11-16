/** Strip anything that looks like a lamp secret from text that may reach a tool result, error or log. */
export function scrub(s: string): string {
  return s
    .replace(/([?&](?:t|token)=)[^&\s"'#<>]*/gi, '$1***')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1***');
}
