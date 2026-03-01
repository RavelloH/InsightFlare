"use client"

import * as React from "react"
import { useMediaQuery } from "@/lib/hooks/use-media-query"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"

interface ResponsiveModalProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function ResponsiveModal({ children, ...props }: ResponsiveModalProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)")

  if (isDesktop) {
    return <Dialog {...props}>{children}</Dialog>
  }

  return <Drawer {...props}>{children}</Drawer>
}

function ResponsiveModalTrigger({ ...props }: React.ComponentProps<typeof DialogTrigger>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogTrigger {...props} /> : <DrawerTrigger {...props} />
}

function ResponsiveModalContent({ className, children, ...props }: React.ComponentProps<typeof DialogContent>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  if (isDesktop) {
    return <DialogContent className={className} {...props}>{children}</DialogContent>
  }
  return <DrawerContent className={className}>{children}</DrawerContent>
}

function ResponsiveModalHeader({ ...props }: React.ComponentProps<typeof DialogHeader>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogHeader {...props} /> : <DrawerHeader {...props} />
}

function ResponsiveModalTitle({ ...props }: React.ComponentProps<typeof DialogTitle>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogTitle {...props} /> : <DrawerTitle {...props} />
}

function ResponsiveModalDescription({ ...props }: React.ComponentProps<typeof DialogDescription>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogDescription {...props} /> : <DrawerDescription {...props} />
}

function ResponsiveModalFooter({ ...props }: React.ComponentProps<typeof DialogFooter>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogFooter {...props} /> : <DrawerFooter {...props} />
}

function ResponsiveModalClose({ ...props }: React.ComponentProps<typeof DialogClose>) {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  return isDesktop ? <DialogClose {...props} /> : <DrawerClose {...props} />
}

export {
  ResponsiveModal,
  ResponsiveModalClose,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
}
