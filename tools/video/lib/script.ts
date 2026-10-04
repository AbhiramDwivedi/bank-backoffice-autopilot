/**
 * Parses tools/video/script.md into an ordered list of clips.
 * `## N. Title` starts a section; `### <clipId> | <kind>:<name>` starts a clip; the text under it is the narration.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type VisualKind = 'slide' | 'live' | 'term';

export interface Clip {
  id: string;
  section: number;
  sectionTitle: string;
  visual: { kind: VisualKind; name: string };
  text: string;
}

export const VIDEO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.resolve(VIDEO_DIR, '..', '..');
export const BUILD_DIR = path.join(VIDEO_DIR, '.build');

export function parseScript(file = path.join(VIDEO_DIR, 'script.md')): Clip[] {
  const lines = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n');
  const clips: Clip[] = [];
  let section = 0;
  let sectionTitle = '';
  let current: Clip | undefined;
  const flush = (): void => {
    if (current) {
      current.text = current.text.replace(/\s+/g, ' ').trim();
      if (!current.text) throw new Error(`clip ${current.id} has no narration`);
      clips.push(current);
    }
    current = undefined;
  };
  for (const line of lines) {
    const sec = /^## (\d+)\. (.+)$/.exec(line);
    if (sec) {
      flush();
      section = Number(sec[1]);
      sectionTitle = sec[2]!.trim();
      continue;
    }
    const clip = /^### (\S+) \| (slide|live|term):(\S+)\s*$/.exec(line);
    if (clip) {
      flush();
      if (section === 0) throw new Error(`clip ${clip[1]} is outside a section`);
      current = { id: clip[1]!, section, sectionTitle, visual: { kind: clip[2] as VisualKind, name: clip[3]! }, text: '' };
      continue;
    }
    if (current) current.text += ` ${line}`;
  }
  flush();
  const ids = new Set<string>();
  for (const c of clips) {
    if (ids.has(c.id)) throw new Error(`duplicate clip id ${c.id}`);
    ids.add(c.id);
  }
  return clips;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clips = parseScript();
  for (const c of clips) console.log(`${c.id} s${c.section} ${c.visual.kind}:${c.visual.name} ${c.text.split(' ').length}w`);
  console.log(`total words: ${clips.reduce((n, c) => n + c.text.split(' ').length, 0)}`);
}
