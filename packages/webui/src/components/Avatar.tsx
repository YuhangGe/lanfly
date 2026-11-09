const COLORS = ['#69b7ff', '#89d185', '#e5c07b', '#f48771', '#c792ea', '#4dd0e1', '#ffb86c'];

function colorFor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

function avatarStyle(id: string): string {
  const color = colorFor(id);
  return `background:${color}22;color:${color};box-shadow:inset 0 0 0 1px ${color}33`;
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

function sizeClass(size: 'sm' | 'md' | 'lg' | undefined): string {
  return size === 'sm'
    ? 'size-7 text-[11px]'
    : size === 'lg'
      ? 'size-10 text-[15px]'
      : 'size-9 text-[13px]';
}

export default function Avatar(props: {
  name: string;
  id: string;
  size?: 'sm' | 'md' | 'lg';
  online?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center rounded-full font-semibold select-none ${sizeClass(props.size)} ${props.className ?? ''}`}
      style={avatarStyle(props.id)}
      aria-hidden="true"
    >
      {initialOf(props.name)}
      {props.online !== undefined && (
        <span
          className={`absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-neutral-10 ${props.online ? 'bg-green-40' : 'bg-neutral-70'}`}
        />
      )}
    </span>
  );
}
