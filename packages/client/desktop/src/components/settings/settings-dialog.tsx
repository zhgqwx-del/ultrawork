import { useState } from "react"
import { useConfig } from "@/lib/config-context"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { config, updateConfig, resetConfig } = useConfig()
  const [formData, setFormData] = useState(config)

  const handleSave = () => {
    updateConfig(formData)
    onOpenChange(false)
  }

  const handleReset = () => {
    resetConfig()
    setFormData(config)
  }

  const handleCancel = () => {
    setFormData(config) // Revert changes
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your OpenCode server connection
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* API Base URL */}
          <div className="space-y-2">
            <label htmlFor="apiBaseUrl" className="text-sm font-medium text-[--color-fg]">
              API Base URL
            </label>
            <input
              id="apiBaseUrl"
              type="text"
              value={formData.apiBaseUrl}
              onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
              placeholder="http://localhost:4096"
              className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
            />
            <p className="text-xs text-[--color-fg-muted]">
              The base URL of your OpenCode server
            </p>
          </div>

          {/* API Username */}
          <div className="space-y-2">
            <label htmlFor="apiUsername" className="text-sm font-medium text-[--color-fg]">
              Username (optional)
            </label>
            <input
              id="apiUsername"
              type="text"
              value={formData.apiUsername || ""}
              onChange={(e) => setFormData({ ...formData, apiUsername: e.target.value })}
              placeholder="opencode"
              className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
            />
            <p className="text-xs text-[--color-fg-muted]">
              Leave empty to use default (opencode)
            </p>
          </div>

          {/* API Password */}
          <div className="space-y-2">
            <label htmlFor="apiPassword" className="text-sm font-medium text-[--color-fg]">
              Password
            </label>
            <input
              id="apiPassword"
              type="password"
              value={formData.apiPassword}
              onChange={(e) => setFormData({ ...formData, apiPassword: e.target.value })}
              placeholder="Enter password"
              className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
            />
            <p className="text-xs text-[--color-fg-muted]">
              Your OpenCode server password
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleReset}>
            Reset to Default
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
