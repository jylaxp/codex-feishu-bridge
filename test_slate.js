function extractSlateText(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(node => {
    if (typeof node === 'string') return node;
    if (typeof node.text === 'string') return node.text;
    if (Array.isArray(node.children)) return extractSlateText(node.children);
    return '';
  }).join('');
}

const summary = [
  {
    "type": "paragraph",
    "children": [
      { "text": "This is a reasoning step." }
    ]
  }
];

console.log(extractSlateText(summary));
