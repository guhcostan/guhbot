import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { JSX } from 'react';

export default function RichText({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
