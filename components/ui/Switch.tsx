interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export const Switch = ({ checked, disabled = false, onChange }: SwitchProps) => (
  <label className={`flex select-none items-center ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
    <div className='relative'>
      <input
        type='checkbox'
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className='sr-only'
      />
      <div
        className={`h-5 w-12 rounded-full shadow-inner transition-colors ${checked ? 'bg-accent-light' : 'bg-surface-light'}`}
      />
      <div
        className={`absolute -top-0.5 flex size-6 items-center justify-center rounded-full bg-white shadow-md transition-all
          ${checked ? 'left-6 rtl:left-0' : 'left-0 rtl:left-6'}`}
      >
        <span
          className={`size-3.5 rounded-full border transition-colors
            ${checked ? 'border-white bg-accent' : 'border-text-muted bg-white'}`}
        />
      </div>
    </div>
  </label>
);
