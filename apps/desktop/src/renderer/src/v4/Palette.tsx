import { useState } from "react";
import { Search, ArrowUpRight } from "lucide-react";
import { Dialog } from "../components/primitives";
export type PaletteAction = {
  name: string;
  detail?: string;
  run: () => void;
  disabled?: boolean;
};
export function Palette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const filtered = actions.filter((a) =>
    a.name.toLowerCase().includes(query.toLowerCase()),
  );
  const run = (action: PaletteAction) => {
    if (!action.disabled) {
      onClose();
      action.run();
    }
  };
  return (
    <Dialog title="Commands" onClose={onClose} className="v4-dialog v4-palette">
      <div className="v4-search">
        <Search size={18} />
        <input
          data-autofocus
          aria-label="Search commands"
          placeholder="What would you like to do?"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="v4-command-list"
          aria-activedescendant={
            filtered[active] ? `v4-command-${active}` : undefined
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive(
                (i) =>
                  (i + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                  Math.max(filtered.length, 1),
              );
            }
            if (e.key === "Enter" && filtered[active]) run(filtered[active]);
          }}
        />
      </div>
      <div role="listbox" id="v4-command-list" aria-label="Commands">
        {filtered.map((action, i) => (
          <button
            role="option"
            id={`v4-command-${i}`}
            aria-selected={active === i}
            aria-disabled={action.disabled}
            key={action.name}
            onClick={() => run(action)}
          >
            <span>
              {action.name}
              <small>{action.detail}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {!filtered.length && <p className="muted">No matching commands.</p>}
      <footer>
        <small>↑ ↓ navigate · Enter select · Esc close</small>
      </footer>
    </Dialog>
  );
}
