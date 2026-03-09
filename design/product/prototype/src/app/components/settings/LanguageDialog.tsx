import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Check } from 'lucide-react';
import { useState } from 'react';

interface LanguageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LanguageDialog({ open, onOpenChange }: LanguageDialogProps) {
  const [selectedLanguage, setSelectedLanguage] = useState('zh-CN');

  const languages = [
    { code: 'zh-CN', name: '简体中文', englishName: 'Simplified Chinese' },
    { code: 'zh-TW', name: '繁體中文', englishName: 'Traditional Chinese' },
    { code: 'en', name: 'English', englishName: 'English' },
    { code: 'ja', name: '日本語', englishName: 'Japanese' },
    { code: 'ko', name: '한국어', englishName: 'Korean' },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>语言切换</DialogTitle>
          <DialogDescription className="sr-only">选择应用程序的显示语言</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 mt-4">
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => setSelectedLanguage(lang.code)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{lang.name}</span>
                <span className="text-xs text-neutral-400">{lang.englishName}</span>
              </div>
              {selectedLanguage === lang.code && (
                <Check className="w-5 h-5 text-green-500" />
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
