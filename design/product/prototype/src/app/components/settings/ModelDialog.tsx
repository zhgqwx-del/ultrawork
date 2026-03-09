import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Search, Plus, Check } from 'lucide-react';
import { useState } from 'react';
import { AddProviderDialog } from './AddProviderDialog';

interface ModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ModelProvider {
  id: string;
  name: string;
  models: string[];
  enabled: boolean;
  apiKey?: string;
}

export function ModelDialog({ open, onOpenChange }: ModelDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [providers, setProviders] = useState<ModelProvider[]>([
    {
      id: 'alibaba',
      name: 'Alibaba Cloud',
      models: ['Qwen3.5 plus', 'Qwen3.5 turbo', 'Qwen2.5'],
      enabled: true,
      apiKey: '已配置'
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: ['GPT-4', 'GPT-4 Turbo', 'GPT-3.5'],
      enabled: true,
      apiKey: '已配置'
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: ['Claude 3 Opus', 'Claude 3 Sonnet', 'Claude 3 Haiku'],
      enabled: false,
    },
    {
      id: 'google',
      name: 'Google',
      models: ['Gemini Pro', 'Gemini Ultra', 'PaLM 2'],
      enabled: true,
      apiKey: '已配置'
    },
  ]);

  const filteredProviders = providers.filter(provider =>
    provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    provider.models.some(model => model.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const toggleProvider = (id: string) => {
    setProviders(providers.map(p => 
      p.id === id ? { ...p, enabled: !p.enabled } : p
    ));
  };

  const handleAddProvider = (newProvider: any) => {
    setProviders([...providers, newProvider]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl bg-neutral-800 border-neutral-700 text-neutral-100">
        <DialogHeader>
          <DialogTitle className="text-xl text-neutral-100">模型配置</DialogTitle>
          <DialogDescription className="text-sm text-neutral-400">
            管理和配置您的 AI 模型供应商
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* 搜索框 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-neutral-500" />
            <input
              type="text"
              placeholder="搜索模型或供应商..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-neutral-750 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
            />
          </div>

          {/* 供应商列表 */}
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {filteredProviders.map((provider) => (
              <div
                key={provider.id}
                className="border border-neutral-700 rounded-lg p-4 hover:border-neutral-600 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-base font-medium text-neutral-100">
                        {provider.name}
                      </h3>
                      {provider.enabled && (
                        <span className="px-2 py-0.5 bg-green-600/20 text-green-400 text-xs rounded">
                          已启用
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {provider.models.map((model) => (
                        <span
                          key={model}
                          className="px-2 py-1 bg-neutral-750 text-neutral-400 text-xs rounded"
                        >
                          {model}
                        </span>
                      ))}
                    </div>
                    {provider.apiKey && (
                      <p className="text-xs text-neutral-500">
                        API密钥: {provider.apiKey}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleProvider(provider.id)}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        provider.enabled
                          ? 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
                          : 'bg-orange-600 text-white hover:bg-orange-500'
                      }`}
                    >
                      {provider.enabled ? '禁用' : '启用'}
                    </button>
                    <button className="px-3 py-1.5 bg-neutral-700 text-neutral-300 hover:bg-neutral-600 rounded-md text-sm transition-colors">
                      配置
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 添加新供应商 */}
          <button 
            onClick={() => setShowAddDialog(true)}
            className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-neutral-700 rounded-lg hover:border-neutral-600 hover:bg-neutral-750 transition-colors"
          >
            <Plus className="w-4 h-4 text-neutral-400" />
            <span className="text-sm text-neutral-400">添加新的模型供应商</span>
          </button>
        </div>

        {/* 添加供应商对话框 */}
        <AddProviderDialog 
          open={showAddDialog} 
          onOpenChange={setShowAddDialog}
          onAdd={handleAddProvider}
        />
      </DialogContent>
    </Dialog>
  );
}
