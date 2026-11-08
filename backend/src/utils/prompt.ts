import { createInterface } from 'node:readline/promises';

/**
 * Terminal prompts shared by the scripts.
 *
 * `promptHidden` echoes `*` per character instead of the input, so a password is
 * never left in the scrollback. When stdin is not a TTY (a pipe, CI, a heredoc)
 * it reads one line instead — raw mode on a pipe would block forever.
 */

export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return readLine();

  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = (): void => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (input: string): void => {
      const chars = String(input);

      if (chars === '\n' || chars === '\r' || chars === '\u0004') {
        finish();
        return;
      }

      if (chars === '\u0003') {
        // Ctrl-C: leave the terminal usable.
        stdin.setRawMode?.(wasRaw ?? false);
        stdout.write('\n');
        process.exit(130);
      }

      if (chars === '\u007f' || chars === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }

      value += chars;
      stdout.write('*');
    };

    stdin.on('data', onData);
    // Piped input ends the stream instead of sending a newline: treat EOF as
    // "done typing".
    stdin.once('end', finish);
  });
}

/** A normal visible prompt (usernames, confirmations). */
export async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/** First line of stdin, for piped invocations. */
async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    rl.close();
    return line;
  }

  rl.close();
  return '';
}
