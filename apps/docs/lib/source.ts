import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';

// The content is the repo-root docs/ folder, read in place. Only .mdx files are
// pages: docs/quality-backlog.md is working notes, not documentation.
const docs = defineDocs({
  dir: '../../docs',
  docs: {
    files: ['**/*.mdx'],
  },
});

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
