import { useNavigate } from "react-router-dom"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Settings,
  Globe,
  FolderOpen,
  HelpCircle,
  Info,
} from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import { useConfig } from "@/lib/config-context"
import type { ReactNode } from "react"

interface SettingsPopoverProps {
  children: ReactNode
}

export function SettingsPopover({ children }: SettingsPopoverProps) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { config, updateConfig } = useConfig()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-52">
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings className="mr-2 size-4" />
          {t("settingsPopover.general")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Globe className="mr-2 size-4" />
            {t("settingsPopover.language")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={config.language}
              onValueChange={(v) => updateConfig({ language: v as "en" | "zh" })}
            >
              <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="zh">简体中文</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => navigate("/workspace")}>
          <FolderOpen className="mr-2 size-4" />
          {t("settingsPopover.workspace")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openUrl("https://docs.ultrawork.ai/guide")}>
          <HelpCircle className="mr-2 size-4" />
          {t("settingsPopover.help")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/settings", { state: { section: "about" } })}>
          <Info className="mr-2 size-4" />
          {t("settingsPopover.about")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
