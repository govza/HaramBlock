import { Fragment, type ReactNode } from 'react';

const SLOT_PATTERN = /\{\{(\d+)\}\}/;

/**
 * The marker passed to `t()` as a substitution so a translated sentence keeps its own word order
 * around a link that `SlotText` then puts in its place.
 */
export const slot = (index: number): string => `{{${index}}}`;

/**
 * Props of a translated sentence with React nodes in its `slot(n)` markers.
 */
interface SlotTextProps {
  text: string;
  slots: ReactNode[];
}

export const SlotText = ({ text, slots }: SlotTextProps) => (
  <>
    {text.split(SLOT_PATTERN).map((part, index) => (
      <Fragment key={index}>{index % 2 === 0 ? part : slots[Number(part)]}</Fragment>
    ))}
  </>
);
