import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

type MenuAlign = 'left' | 'right';

interface NaveMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: { readonly current: HTMLElement | null };
  align?: MenuAlign;
  /** Stretch the menu to the trigger width. */
  matchWidth?: boolean;
  minWidth?: number;
  /** Keep nested flyouts visible. Select menus stay clipped and scroll. */
  overflowVisible?: boolean;
  children: ReactNode;
}

/**
 * Instant anchored menu. No fade, zoom, or backdrop — those were stalling
 * the network and product menus on open.
 */
export function NaveMenu({
  open,
  onClose,
  anchorRef,
  align = 'left',
  matchWidth = false,
  minWidth = 180,
  overflowVisible = false,
  children,
}: NaveMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setBox({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef]);

  if (!open || !box || typeof document === 'undefined') return null;

  const width = Math.max(box.width, minWidth);
  const style: CSSProperties = {
    top: box.top,
    minWidth: width,
    width: matchWidth ? width : undefined,
  };
  if (align === 'right') {
    style.right = Math.max(8, window.innerWidth - (box.left + box.width));
  } else {
    style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="nave-menu"
      style={overflowVisible ? { ...style, overflow: 'visible' } : style}
    >
      {children}
    </div>,
    document.body,
  );
}

export function NaveMenuItem({
  selected = false,
  disabled = false,
  onClick,
  children,
}: {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="nave-menu-item"
      data-selected={selected ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="nave-menu-item-label">{children}</span>
      {selected ? <span className="nave-menu-check" aria-hidden>✓</span> : null}
    </button>
  );
}

interface MenuOption {
  value: string;
  label: string;
  disabled: boolean;
}

function optionLabel(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionLabel).join('');
  return '';
}

function collectOptions(children: ReactNode): MenuOption[] {
  const out: MenuOption[] = [];
  const walk = (nodes: ReactNode) => {
    ChildrenForEach(nodes, (child) => {
      if (!isElement(child)) return;
      const props = child.props as { value?: string | number; disabled?: boolean; children?: ReactNode };
      if (child.type === 'option') {
        const label = optionLabel(props.children).trim();
        out.push({
          value: props.value == null ? label : String(props.value),
          label: label || String(props.value ?? ''),
          disabled: !!props.disabled,
        });
        return;
      }
      if (child.type === 'optgroup' || child.type === FragmentType) {
        walk(props.children);
      }
    });
  };
  walk(children);
  return out;
}

const FragmentType = Fragment;

function isElement(node: ReactNode): node is ReactElement {
  return isValidElement(node);
}

function ChildrenForEach(nodes: ReactNode, fn: (child: ReactNode) => void) {
  Children.forEach(nodes, fn);
}

type NaveSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  children?: ReactNode;
};

/** Drop-in for native `<select>` so every menu shares one instant style. */
export function NaveSelect({
  value,
  onChange,
  children,
  id,
  style,
  className,
  disabled,
  name,
  required,
  'aria-label': ariaLabel,
}: NaveSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const options = collectOptions(children);
  const current = String(value ?? '');
  const selected = options.find((option) => option.value === current);
  const boxStyle: CSSProperties = {
    width: style?.width ?? '100%',
    maxWidth: style?.maxWidth,
  };

  return (
    <div className="nave-select" ref={rootRef} style={boxStyle}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={className ? `nave-select-trigger ${className}` : 'nave-select-trigger'}
        style={style}
        onClick={() => {
          if (!disabled) setOpen((next) => !next);
        }}
      >
        <span className="nave-menu-item-label">{selected?.label ?? ''}</span>
        <span className="nave-select-chevron" aria-hidden>
          ⌄
        </span>
      </button>
      {(name != null || required) && (
        <input type="hidden" name={name} value={current} required={required} />
      )}
      <NaveMenu open={open} onClose={close} anchorRef={rootRef} matchWidth minWidth={160}>
        {options.map((option, index) => (
          <NaveMenuItem
            key={`${option.value}-${index}`}
            selected={option.value === current}
            disabled={option.disabled}
            onClick={() => {
              onChange?.({
                target: { value: option.value },
                currentTarget: { value: option.value },
              } as ChangeEvent<HTMLSelectElement>);
              setOpen(false);
            }}
          >
            {option.label}
          </NaveMenuItem>
        ))}
      </NaveMenu>
    </div>
  );
}
