export function buildSelectedMessageReplyInsertion(prompt: string, selection: string): string {
  const selectedText = selection.replaceAll("\r\n", "\n").trim();
  if (selectedText.length === 0) return "";

  const separator =
    prompt.length === 0 || prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
  const quote = selectedText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${separator}${quote}\n\n`;
}
