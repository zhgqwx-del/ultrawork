import { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { SettingsMenu } from './SettingsMenu';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface SettingsPopoverProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFullSettings: () => void;
}

export function SettingsPopover({ children, open, onOpenChange, onOpenFullSettings }: SettingsPopoverProps) {
  const { theme } = useTheme();
  
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent 
        side="bottom" 
        align="center" 
        className={`w-52 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
        sideOffset={8}
      >
        <SettingsMenu 
          onClose={() => onOpenChange(false)} 
          onOpenFullSettings={() => {
            onOpenChange(false);
            onOpenFullSettings();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
