// Notion's own markdown (what GET /v1/pages/:id/markdown returns), made into plain markdown for ui/markdown.ts.

const NOTION_LAYOUT_RE = /^<\/?columns?\b[^>]*>$/;
const NOTION_MEDIA_RE = /<(video|audio|file|pdf)\s+src="([^"]+)"[^>]*?(?:\/>|>(.*?)<\/\1>)/g;

/**
 * Notion's markdown (GET /v1/pages/:id/markdown) as plain markdown: columns flattened into the page
 * (their content is indented under them, which would read as code), empty blocks as blank lines,
 * videos and sound as players, other files as links.
 */
export function fromNotion(src: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (NOTION_LAYOUT_RE.test(t)) {
      depth = Math.max(0, depth + (t.startsWith('</') ? -1 : 1));
      out.push('');
      continue;
    }
    if (t === '<empty-block/>') {
      out.push('');
      continue;
    }
    const l = depth ? line.replace(new RegExp(`^\\t{0,${depth}}`), '') : line;
    out.push(
      l.replace(NOTION_MEDIA_RE, (_, tag: string, url: string, caption?: string) => {
        if (tag === 'video' || tag === 'audio') return `<${tag} src="${url}"></${tag}>`;
        const name = caption?.trim() || decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'file';
        return `[📎 ${name}](${url})`;
      }),
    );
  }
  return out.join('\n');
}
