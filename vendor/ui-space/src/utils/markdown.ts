function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const tag = node.tagName.toLowerCase();
  const children = [...node.childNodes].map(inline).join('');
  if (node.dataset.linkCard) {
    return `[${node.dataset.linkCard}](${node.dataset.linkCard})`;
  }
  if (tag === 'strong' || tag === 'b') return `**${children}**`;
  if (tag === 'em' || tag === 'i') return `*${children}*`;
  if (tag === 'u') return `<u>${children}</u>`;
  if (tag === 's' || tag === 'del' || tag === 'strike')
    return `~~${children}~~`;
  if (tag === 'code') return `\`${node.textContent ?? ''}\``;
  if (tag === 'mark') return `==${children}==`;
  if (tag === 'br') return '  \n';
  if (tag === 'a') {
    const href = node.getAttribute('href') ?? '';
    return `[${children}](${href})`;
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`;
  }
  if (node.dataset.file) {
    return `[${node.dataset.file}](${node.dataset.href ?? ''})`;
  }
  return children;
}

function block(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const tag = node.tagName.toLowerCase();
  if (node.dataset.linkCard) return `${inline(node)}\n\n`;
  if (tag === 'p') return `${inline(node)}\n\n`;
  if (tag === 'h1') return `# ${inline(node)}\n\n`;
  if (tag === 'h2') return `## ${inline(node)}\n\n`;
  if (tag === 'h3') return `### ${inline(node)}\n\n`;
  if (tag === 'blockquote') {
    const content = [...node.childNodes].map((child) => block(child)).join('');
    return `${content
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = [...node.children]
      .filter((child) => child.tagName.toLowerCase() === 'li')
      .map((child, index) => {
        const marker = tag === 'ol' ? `${index + 1}.` : '-';
        const content = [...child.childNodes]
          .map((item) => inline(item))
          .join('')
          .trim();
        return `${'  '.repeat(depth)}${marker} ${content}\n`;
      })
      .join('');
    return `${items}\n`;
  }
  if (tag === 'pre') {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const lineBreak of clone.querySelectorAll('br'))
      lineBreak.replaceWith('\n');
    return `\`\`\`\n${(clone.textContent ?? '').replaceAll('\u200b', '')}\n\`\`\`\n\n`;
  }
  if (tag === 'hr') return '---\n\n';
  if (tag === 'table') {
    const rows = [...node.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) =>
        inline(cell).replaceAll('\n', ' ').trim(),
      ),
    );
    if (!rows.length) return '';
    const head = rows[0] ?? [];
    const separator = head.map(() => '---');
    const body = rows.slice(1);
    return `${[head, separator, ...body]
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n')}\n\n`;
  }
  if (tag === 'div' || tag === 'section') {
    if (node.dataset.divider !== undefined) return '---\n\n';
    if (node.dataset.todo !== undefined) {
      const checked = node.dataset.checked === 'true' ? 'x' : ' ';
      const text = node.querySelector('[data-todo-text]')?.textContent ?? '';
      return `- [${checked}] ${text}\n\n`;
    }
    return [...node.childNodes].map((child) => block(child)).join('');
  }
  if (tag === 'img' || tag === 'a' || tag === 'span') return inline(node);
  return [...node.childNodes].map((child) => block(child)).join('');
}

export function htmlToMarkdown(html: string) {
  const documentNode = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    'text/html',
  );
  return [...documentNode.body.childNodes]
    .map((node) => block(node))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function downloadMarkdown(title: string, html: string) {
  const content = `# ${title}\n\n${htmlToMarkdown(html)}\n`;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|]/g, ' ').trim() || '文档'}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
