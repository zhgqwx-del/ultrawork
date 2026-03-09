import { useState } from 'react';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Download, Upload, ExternalLink } from 'lucide-react';

export function PrivacySettings() {
  const [sessionSharing, setSessionSharing] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl mb-6">数据保护</h2>
        
        <div className="bg-neutral-800 rounded-lg p-6 mb-6">
          <p className="text-sm text-neutral-300 mb-4">
            我们重视您的隐私和数据安全。您的所有数据都经过加密存储，并且仅在您的授权下使用。
          </p>
          <div className="flex gap-4">
            <a
              href="#"
              className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
            >
              使用条款
              <ExternalLink className="w-4 h-4" />
            </a>
            <a
              href="#"
              className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
            >
              隐私政策
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-2xl mb-6">数据管理</h2>
        
        {/* 数据导入 */}
        <div className="mb-6 pb-6 border-b border-neutral-800">
          <Label className="text-sm text-neutral-200 block mb-2">
            数据导入
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            导入您的工作目录、对话记录或用户设置
          </p>
          <button className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors text-sm">
            <Upload className="w-4 h-4" />
            导入数据
          </button>
        </div>

        {/* 数据导出 */}
        <div className="mb-6 pb-6 border-b border-neutral-800">
          <Label className="text-sm text-neutral-200 block mb-2">
            数据导出
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            导出您的工作目录、对话记录或用户设置
          </p>
          <button className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors text-sm">
            <Download className="w-4 h-4" />
            导出数据
          </button>
        </div>

        {/* 会话共享 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              会话共享
            </Label>
            <p className="text-xs text-neutral-500 mt-1">
              允许通过链接分享您的对话会话
            </p>
          </div>
          <Switch checked={sessionSharing} onCheckedChange={setSessionSharing} />
        </div>

        {/* 记忆偏好 */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              记忆偏好
            </Label>
            <p className="text-xs text-neutral-500 mt-1">
              允许系统记住您的偏好和历史对话，以提供更个性化的体验
            </p>
          </div>
          <Switch checked={memoryEnabled} onCheckedChange={setMemoryEnabled} />
        </div>
      </div>

      <div>
        <h2 className="text-2xl mb-6">数据清除</h2>
        
        <div className="bg-neutral-800 rounded-lg p-6">
          <Label className="text-sm text-neutral-200 block mb-2">
            清除所有数据
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            这将删除您的所有对话记录、设置和用户数据。此操作不可撤销。
          </p>
          <button className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-md transition-colors text-sm">
            清除所有数据
          </button>
        </div>
      </div>
    </div>
  );
}
