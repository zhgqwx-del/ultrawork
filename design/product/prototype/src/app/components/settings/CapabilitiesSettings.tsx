import { useState } from 'react';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Download, Upload } from 'lucide-react';

export function CapabilitiesSettings() {
  const [memoryGeneration, setMemoryGeneration] = useState(true);
  const [toolAccessMode, setToolAccessMode] = useState('auto');

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl mb-6">记忆管理</h2>
        
        {/* 从聊天记录生成记忆 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              从聊天记录生成记忆
            </Label>
            <p className="text-xs text-neutral-500 mt-1">
              自动从对话中提取和保存重要信息，用于改善未来的交互
            </p>
          </div>
          <Switch checked={memoryGeneration} onCheckedChange={setMemoryGeneration} />
        </div>

        {/* 导入记忆 */}
        <div className="mb-6 pb-6 border-b border-neutral-800">
          <Label className="text-sm text-neutral-200 block mb-2">
            导入记忆
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            从文件导入之前保存的记忆数据
          </p>
          <button className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors text-sm">
            <Upload className="w-4 h-4" />
            导入记忆
          </button>
        </div>

        {/* 导出记忆 */}
        <div className="mb-6">
          <Label className="text-sm text-neutral-200 block mb-2">
            导出记忆
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            将当前的记忆数据导出到文件
          </p>
          <button className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors text-sm">
            <Download className="w-4 h-4" />
            导出记忆
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-2xl mb-6">工具配置</h2>
        
        {/* 工具访问模式 */}
        <div className="mb-6">
          <Label className="text-sm text-neutral-200 block mb-2">
            工具访问模式
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            控制连接器工具在新对话中加载的方式
          </p>
          
          <div className="space-y-3">
            {/* 自动 */}
            <label className="flex items-start gap-3 p-4 bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-750 transition-colors">
              <input
                type="radio"
                name="toolAccessMode"
                value="auto"
                checked={toolAccessMode === 'auto'}
                onChange={(e) => setToolAccessMode(e.target.value)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm text-neutral-200 mb-1">自动</div>
                <div className="text-xs text-neutral-500">
                  为您自动选择。
                </div>
              </div>
            </label>

            {/* 按需 */}
            <label className="flex items-start gap-3 p-4 bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-750 transition-colors">
              <input
                type="radio"
                name="toolAccessMode"
                value="on-demand"
                checked={toolAccessMode === 'on-demand'}
                onChange={(e) => setToolAccessMode(e.target.value)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm text-neutral-200 mb-1">按需</div>
                <div className="text-xs text-neutral-500">
                  需要时才加载。消息更多，准确性更低。
                </div>
              </div>
            </label>

            {/* 始终可用 */}
            <label className="flex items-start gap-3 p-4 bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-750 transition-colors">
              <input
                type="radio"
                name="toolAccessMode"
                value="always"
                checked={toolAccessMode === 'always'}
                onChange={(e) => setToolAccessMode(e.target.value)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm text-neutral-200 mb-1">始终可用</div>
                <div className="text-xs text-neutral-500">
                  启动即就绪。消息更少，准确性更高。
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-2xl mb-6">性能优化</h2>
        
        <div className="bg-neutral-800 rounded-lg p-6">
          <Label className="text-sm text-neutral-200 block mb-2">
            清除缓存
          </Label>
          <p className="text-xs text-neutral-500 mb-4">
            清除工具和连接器的缓存数据，可能会提高性能
          </p>
          <button className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 rounded-md transition-colors text-sm">
            清除缓存
          </button>
        </div>
      </div>
    </div>
  );
}
