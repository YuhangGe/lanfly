import type { ButtonHTMLAttributes, Ref } from 'jinge';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'plain' | 'primary' | 'secondary' | 'danger';
  size?: 'default' | 'compact' | 'icon' | 'bare';
  elementRef?: Ref<HTMLButtonElement>;
};

const variants = {
  plain: '',
  ghost: 'enabled:hover:bg-white/5',
  primary: 'bg-blue-30 text-white enabled:hover:bg-blue-20',
  secondary: 'border border-neutral-60 enabled:hover:bg-white/5',
  danger: 'bg-red-30 text-white enabled:hover:bg-red-10',
};

const sizes = {
  default: 'rounded-control px-3 py-1.5',
  compact: 'rounded-control px-1.5 py-1 text-[11px]',
  icon: 'grid size-[24px] place-items-center text-[17px]',
  bare: '',
};

const variantClass = (variant: NonNullable<Props['variant']>) => variants[variant];
const sizeClass = (size: NonNullable<Props['size']>) => sizes[size];

export default function Button(props: Props) {
  return (
    <button
      ref={(element) => {
        if (props.elementRef) props.elementRef.value = element;
      }}
      type={props.type ?? 'button'}
      className={`cursor-pointer transition-colors duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-blue-40 disabled:cursor-default disabled:opacity-40 ${variantClass(props.variant ?? 'ghost')} ${sizeClass(props.size ?? 'default')} ${props.className ?? ''}`}
      style={props.style}
      title={props.title}
      disabled={props.disabled}
      role={props.role}
      tabIndex={props.tabIndex}
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-checked={props['aria-checked']}
      aria-haspopup={props['aria-haspopup']}
      aria-current={props['aria-current']}
      on:click={props['on:click']}
      on:keyDown={props['on:keyDown']}
    >
      {props.children}
    </button>
  );
}
