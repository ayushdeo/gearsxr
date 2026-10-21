// Reads a Blob line by line through its stream, so large trajectories are
// never held as one big JS string. Shared by the XYZ and LAMMPS dump parsers.

export interface LineReader {
  /** Next line without its line ending, or null at the end of the file. */
  next(): Promise<string | null>;
  /** Bytes consumed from the file so far. */
  bytesRead(): number;
}

export function createLineReader(file: Blob): LineReader {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let bytesRead = 0;

  async function next(): Promise<string | null> {
    while (true) {
      const nlIndex = buffer.indexOf("\n");
      if (nlIndex !== -1) {
        const line = buffer.slice(0, nlIndex).replace(/\r$/, "");
        buffer = buffer.slice(nlIndex + 1);
        return line;
      }
      if (done) {
        if (buffer.length > 0) {
          const line = buffer;
          buffer = "";
          return line;
        }
        return null;
      }
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        done = true;
        continue;
      }
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return { next, bytesRead: () => bytesRead };
}
