import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { X, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Label } from '../ui/label';

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: any) => void;
}

interface Model {
  id: string;
  displayName: string;
  params?: string;
}

export function AddProviderDialog({ open, onOpenChange, onAdd }: AddProviderDialogProps) {
  const [displayName, setDisplayName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Model[]>([{ id: '', displayName: '', params: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleAddModel = () => {
    setModels([...models, { id: '', displayName: '', params: '' }]);
  };

  const handleRemoveModel = (index: number) => {
    if (models.length > 1) {
      setModels(models.filter((_, i) => i !== index));
    }
  };

  const handleModelChange = (index: number, field: keyof Model, value: string) => {
    const newModels = [...models];
    newModels[index] = { ...newModels[index], [field]: value };
    setModels(newModels);
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!displayName.trim()) {
      newErrors.displayName = '显示名称不能为空';
    }
    if (!providerId.trim()) {
      newErrors.providerId = '提供商ID不能为空';
    }
    if (!baseUrl.trim()) {
      newErrors.baseUrl = 'Base URL不能为空';
    }

    models.forEach((model, index) => {
      if (!model.id.trim()) {
        newErrors[`model-${index}-id`] = '模型ID不能为空';
      }
      if (!model.displayName.trim()) {
        newErrors[`model-${index}-name`] = '显示名称不能为空';
      }
      if (model.params && model.params.trim()) {
        try {
          JSON.parse(model.params);
        } catch (e) {
          newErrors[`model-${index}-params`] = 'JSON格式无效';
        }
      }
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (validateForm()) {
      const provider = {
        id: providerId,
        name: displayName,
        baseUrl,
        apiKey,
        models: models.map(m => ({
          id: m.id,
          displayName: m.displayName,
          params: m.params ? JSON.parse(m.params) : undefined
        })),
        enabled: true
      };
      onAdd(provider);
      handleClose();
    }
  };

  const handleClose = () => {
    setDisplayName('');
    setProviderId('');
    setBaseUrl('');
    setApiKey('');
    setModels([{ id: '', displayName: '', params: '' }]);
    setErrors({});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-neutral-800 border-neutral-700 text-neutral-100">
        <DialogHeader className="flex flex-row items-center justify-between border-b border-neutral-700 pb-4">
          <DialogTitle className="text-xl text-neutral-100">创建自定义提供商</DialogTitle>
          <button 
            onClick={handleClose}
            className="hover:bg-neutral-700 p-1 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </DialogHeader>

        <DialogDescription className="text-sm text-neutral-400 mt-4">
          配置兼容 OpenAI 的 API 提供商以供 OpenCode 使用。
        </DialogDescription>

        <div className="mt-6">
          {/* 两列布局 */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            {/* 左列：显示名称 */}
            <div>
              <Label className="text-sm text-neutral-300 mb-2 block">
                显示名称 <span className="text-red-500">*</span>
              </Label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Custom Provider"
                className={`w-full px-4 py-2.5 bg-neutral-750 border ${
                  errors.displayName ? 'border-red-500' : 'border-neutral-700'
                } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600`}
              />
              <p className="text-xs text-neutral-500 mt-1">
                为此提供商设置一个友好的名称
              </p>
              {errors.displayName && (
                <p className="text-xs text-red-500 mt-1">{errors.displayName}</p>
              )}
            </div>

            {/* 右列：Base URL */}
            <div>
              <Label className="text-sm text-neutral-300 mb-2 block">
                Base URL <span className="text-red-500">*</span>
              </Label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={`w-full px-4 py-2.5 bg-neutral-750 border ${
                  errors.baseUrl ? 'border-red-500' : 'border-neutral-700'
                } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600`}
              />
              <p className="text-xs text-neutral-500 mt-1">
                API 端点的基础 URL（如 https://api.openai.com/v1）
              </p>
              {errors.baseUrl && (
                <p className="text-xs text-red-500 mt-1">{errors.baseUrl}</p>
              )}
            </div>

            {/* 左列：提供商 ID */}
            <div>
              <Label className="text-sm text-neutral-300 mb-2 block">
                提供商 ID <span className="text-red-500">*</span>
              </Label>
              <input
                type="text"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="my-custom-provider"
                className={`w-full px-4 py-2.5 bg-neutral-750 border ${
                  errors.providerId ? 'border-red-500' : 'border-neutral-700'
                } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600`}
              />
              <p className="text-xs text-neutral-500 mt-1">
                小写字母数字和连字符（如 my-provider）
              </p>
              {errors.providerId && (
                <p className="text-xs text-red-500 mt-1">{errors.providerId}</p>
              )}
            </div>

            {/* 右列：API Key */}
            <div>
              <Label className="text-sm text-neutral-300 mb-2 block">
                API Key
              </Label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="{env:MY_API_KEY} or sk-..."
                className="w-full px-4 py-2.5 bg-neutral-750 border border-neutral-700 rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
              />
              <p className="text-xs text-neutral-500 mt-1">
                使用 {'{env:VAR_NAME}'} 引用环境变量或直接粘贴 API key
              </p>
            </div>
          </div>

          {/* 模型配置（全宽） */}
          <div>
            <Label className="text-sm text-neutral-300 mb-2 block">
              模型 <span className="text-red-500">*</span>
            </Label>
            <div className="space-y-4">
              {models.map((model, index) => (
                <div key={index} className="border border-neutral-700 rounded-lg p-4 space-y-4">
                  <div className="flex items-start gap-3">
                    {/* 模型 ID */}
                    <div className="flex-1">
                      <input
                        type="text"
                        value={model.id}
                        onChange={(e) => handleModelChange(index, 'id', e.target.value)}
                        placeholder="模型 ID（如 gpt-4）"
                        className={`w-full px-3 py-2 bg-neutral-750 border ${
                          errors[`model-${index}-id`] ? 'border-red-500' : 'border-neutral-700'
                        } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600`}
                      />
                      {errors[`model-${index}-id`] && (
                        <p className="text-xs text-red-500 mt-1">{errors[`model-${index}-id`]}</p>
                      )}
                    </div>

                    {/* 显示名称 */}
                    <div className="flex-1">
                      <input
                        type="text"
                        value={model.displayName}
                        onChange={(e) => handleModelChange(index, 'displayName', e.target.value)}
                        placeholder="显示名称（如 GPT-4）"
                        className={`w-full px-3 py-2 bg-neutral-750 border ${
                          errors[`model-${index}-name`] ? 'border-red-500' : 'border-neutral-700'
                        } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600`}
                      />
                      {errors[`model-${index}-name`] && (
                        <p className="text-xs text-red-500 mt-1">{errors[`model-${index}-name`]}</p>
                      )}
                    </div>

                    {/* 删除按钮 */}
                    <button
                      onClick={() => handleRemoveModel(index)}
                      disabled={models.length === 1}
                      className={`p-2 rounded transition-colors ${
                        models.length === 1
                          ? 'text-neutral-600 cursor-not-allowed'
                          : 'text-neutral-400 hover:text-red-400 hover:bg-neutral-700'
                      }`}
                      title="删除模型"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* 模型参数配置（可选） */}
                  <div>
                    <Label className="text-xs text-neutral-400 mb-1.5 block">
                      模型参数配置（可选，JSON格式）
                    </Label>
                    <textarea
                      value={model.params || ''}
                      onChange={(e) => handleModelChange(index, 'params', e.target.value)}
                      placeholder={'{\n  "temperature": 0.7,\n  "max_tokens": 2000\n}'}
                      rows={4}
                      className={`w-full px-3 py-2 bg-neutral-750 border ${
                        errors[`model-${index}-params`] ? 'border-red-500' : 'border-neutral-700'
                      } rounded-md text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600 font-mono`}
                    />
                    {errors[`model-${index}-params`] && (
                      <p className="text-xs text-red-500 mt-1">{errors[`model-${index}-params`]}</p>
                    )}
                    <p className="text-xs text-neutral-500 mt-1">
                      配置该模型的默认参数，如 temperature、max_tokens 等
                    </p>
                  </div>
                </div>
              ))}

              {/* 添加模型按钮 */}
              <button
                onClick={handleAddModel}
                className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-750 rounded-md transition-colors"
              >
                <Plus className="w-4 h-4" />
                添加模型
              </button>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-neutral-700">
          <button
            onClick={handleClose}
            className="px-6 py-2.5 bg-neutral-700 text-neutral-300 hover:bg-neutral-600 rounded-md text-sm transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="px-6 py-2.5 bg-neutral-600 text-white hover:bg-neutral-500 rounded-md text-sm transition-colors"
          >
            创建
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
