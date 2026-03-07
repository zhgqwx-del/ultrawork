import { useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Settings,
  Globe,
  Cpu,
  FolderOpen,
  Radio,
  Server,
  HelpCircle,
  Info,
} from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import { useModel } from "@/lib/model-context"
import type { ReactNode } from "react"

interface SettingsPopoverProps {
  children: ReactNode
}

export function SettingsPopover({ children }: SettingsPopoverProps) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { openModelDialog } = useModel()

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
        <DropdownMenuItem disabled>
          <Globe className="mr-2 size-4" />
          {t("settingsPopover.language")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={openModelDialog}>
          <Cpu className="mr-2 size-4" />
          {t("settingsPopover.models")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <FolderOpen className="mr-2 size-4" />
          {t("settingsPopover.workspace")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Radio className="mr-2 size-4" />
          {t("settingsPopover.channels")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Server className="mr-2 size-4" />
          {t("settingsPopover.remote")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <HelpCircle className="mr-2 size-4" />
          {t("settingsPopover.help")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Info className="mr-2 size-4" />
          {t("settingsPopover.about")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
