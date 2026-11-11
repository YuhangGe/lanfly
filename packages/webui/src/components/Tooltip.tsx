import type { JNode } from 'jinge';

export default function Tooltip(props: {
  children: JNode;
  content: JNode;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <span className="group relative inline-flex">
      {props.children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-2 w-max max-w-[min(340px,calc(100vw-24px))] translate-y-1 rounded-[7px] border border-neutral-60 bg-neutral-30 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-neutral-110 opacity-0 shadow-toolbar transition-[opacity,transform] duration-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 ${
          props.align === 'start'
            ? 'left-0'
            : props.align === 'end'
              ? 'right-0'
              : 'left-1/2 -translate-x-1/2'
        }`}
      >
        <span className="block break-all whitespace-pre-line">{props.content}</span>
      </span>
    </span>
  );
}
