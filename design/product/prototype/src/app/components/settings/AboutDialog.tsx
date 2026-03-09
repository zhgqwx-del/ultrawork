import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { ExternalLink, Github, MessageCircle, RefreshCw } from 'lucide-react';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const version = '1.0.5';
  const latestVersion = '1.0.6';
  const hasUpdate = version !== latestVersion;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-white max-w-lg">
        <DialogHeader>
          <DialogTitle>关于我们</DialogTitle>
          <DialogDescription className="sr-only">应用版本和支持信息</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* 版本信息 */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-neutral-400">版本信息</h4>
            <div className="p-4 bg-neutral-800 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-neutral-400">当前版本</span>
                <span className="text-sm font-mono font-medium">v{version}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-400">最新版本</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono font-medium">v{latestVersion}</span>
                  {hasUpdate && (
                    <span className="px-2 py-0.5 bg-orange-600/20 text-orange-500 text-xs rounded">
                      可更新
                    </span>
                  )}
                </div>
              </div>
            </div>

            {hasUpdate && (
              <button className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg transition-colors">
                <RefreshCw className="w-4 h-4" />
                <span className="text-sm">更新到 v{latestVersion}</span>
              </button>
            )}
          </div>

          {/* 链接 */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-neutral-400">相关链接</h4>
            <div className="space-y-2">
              <a
                href="https://example.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 bg-neutral-800 hover:bg-neutral-750 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-neutral-700 rounded flex items-center justify-center">
                    <ExternalLink className="w-4 h-4 text-neutral-400" />
                  </div>
                  <span className="text-sm">官方网站</span>
                </div>
                <ExternalLink className="w-4 h-4 text-neutral-500 group-hover:text-neutral-300" />
              </a>

              <a
                href="https://github.com/example/project"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 bg-neutral-800 hover:bg-neutral-750 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-neutral-700 rounded flex items-center justify-center">
                    <Github className="w-4 h-4 text-neutral-400" />
                  </div>
                  <span className="text-sm">GitHub 仓库</span>
                </div>
                <ExternalLink className="w-4 h-4 text-neutral-500 group-hover:text-neutral-300" />
              </a>

              <a
                href="https://example.com/feedback"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 bg-neutral-800 hover:bg-neutral-750 rounded-lg transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-neutral-700 rounded flex items-center justify-center">
                    <MessageCircle className="w-4 h-4 text-neutral-400" />
                  </div>
                  <span className="text-sm">问题反馈</span>
                </div>
                <ExternalLink className="w-4 h-4 text-neutral-500 group-hover:text-neutral-300" />
              </a>
            </div>
          </div>

          {/* 版权信息 */}
          <div className="pt-4 border-t border-neutral-800 text-center">
            <p className="text-xs text-neutral-500">
              © 2026 晚的的助手. All rights reserved.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
