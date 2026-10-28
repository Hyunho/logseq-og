const { Buffer } = globalThis.process.getBuiltinModule('buffer');
let Mldoc;
function configure(parser) { Mldoc = parser; }
const config = JSON.stringify({format:'Markdown',keep_line_break:true,toc:false,heading_number:false,heading_to_list:false,parse_outline_only:false,inline_type_with_pos:true});
const stem = p => p.replace(/\.(md|markdown)$/i, '');
function resolve(paths, target) {
  target = target.normalize('NFC');
  const qualified = target.includes('/'), ext = /\.(md|markdown)$/i.test(target);
  return paths.filter(p => {
    const name = qualified ? p : p.split('/').pop();
    return (ext ? name : stem(name)).normalize('NFC') === target;
  });
}
function links(content) {
  const bytes = Buffer.from(content), result = [];
  function inline(raw, offset) {
    const local = Buffer.from(raw);
    for (const [node, at] of JSON.parse(Mldoc.parseInlineJson(raw, config))) {
      if (!at) continue;
      const text = local.subarray(at.start_pos, at.end_pos).toString();
      if (node[0] === 'Emphasis') {
        const marker = text.match(/^(\*\*|__|~~|\*|_)/)?.[0];
        if (marker && text.endsWith(marker)) inline(text.slice(marker.length, -marker.length), offset + at.start_pos + marker.length);
        continue;
      }
      let target;
      if (node[0] === 'Link' && node[1].url?.[0] === 'Page_ref') target = node[1].url[1];
      if (node[0] === 'Macro' && node[1].name === 'embed' && /^\[\[.*\]\]$/.test(node[1].arguments?.[0])) target = node[1].arguments[0].slice(2,-2);
      if (!target || !text.includes(`[[${target}]]`)) continue;
      result.push({ target, start: offset + at.start_pos, end: offset + at.end_pos, text });
    }
  }
  for (const [block, pos] of JSON.parse(Mldoc.parseJson(content, config))) {
    // Code, HTML and property nodes are intentionally excluded from rewriting.
    if (!['Heading', 'Paragraph', 'Quote'].includes(block[0])) continue;
    inline(bytes.subarray(pos.start_pos, pos.end_pos).toString(), pos.start_pos);
  }
  return result;
}

function changes(content, beforePaths, afterPaths, moves = {}) {
  return links(content).flatMap(link => {
    const before = resolve(beforePaths, link.target);
    if (before.length !== 1) return [];
    const prior = before[0], destination = moves[prior] || prior;
    if (!afterPaths.includes(destination)) return [];
    const after = resolve(afterPaths, link.target);
    if (after.length === 1 && after[0] === destination) return [];
    const short = stem(destination);
    const basename = short.split('/').pop();
    const target = !link.target.includes('/') && resolve(afterPaths, basename).length === 1
      ? basename : resolve(afterPaths, short).length === 1 ? short : destination;
    return [{ ...link, replacement: link.text.replace(`[[${link.target}]]`, `[[${target}]]`), destination }];
  });
}
function apply(content, items) {
  let bytes = Buffer.from(content);
  for (const item of [...items].sort((a,b) => b.start - a.start)) {
    bytes = Buffer.concat([bytes.subarray(0,item.start), Buffer.from(item.replacement), bytes.subarray(item.end)]);
  }
  return bytes.toString();
}
module.exports = { configure, resolve, links, changes, apply };
