import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SelectChangeEvent = { target: { value: string } };

interface SelectControlProps {
  "aria-label"?: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onChange?: (event: SelectChangeEvent) => void;
  title?: string;
  value: string;
}

interface SelectOptionProps {
  children?: React.ReactNode;
  disabled?: boolean;
  value?: string | number;
}

/**
 * Keeps existing controlled form state small while delegating all interaction,
 * focus management, keyboard navigation, and popup rendering to shadcn/Base UI.
 */
function SelectControl({
  children,
  className,
  disabled,
  onChange,
  title,
  value,
  "aria-label": ariaLabel,
}: SelectControlProps) {
  const options = React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement<SelectOptionProps>(child) || child.type !== "option") return [];
    const optionValue = child.props.value;
    if (optionValue === undefined) return [];
    return [{
      disabled: child.props.disabled,
      label: child.props.children,
      value: String(optionValue),
    }];
  });
  const selectedOption = options.find((option) => option.value === value);
  const fallbackLabel = options.find((option) => typeof option.label === "string")?.label as string | undefined;

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onChange?.({ target: { value: String(nextValue) } });
      }}
    >
      <SelectTrigger className={className} aria-label={ariaLabel ?? fallbackLabel} title={title}>
        <SelectValue>{selectedOption?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { SelectControl };
