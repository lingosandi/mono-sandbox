"use client"

import React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { ChevronRight } from "lucide-react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"

const treeVariants = cva(
    "group hover:before:opacity-100 before:absolute before:rounded-lg before:left-0 px-2 before:w-full before:opacity-0 before:bg-white/5 before:h-[2rem] before:-z-10"
)

const selectedTreeVariants = cva(
    "before:opacity-100 before:bg-white/10 text-zinc-100"
)

interface TreeDataItem {
    id: string
    name: string
    icon?: React.ComponentType<{ className?: string }>
    children?: TreeDataItem[]
    onClick?: () => void
    contextMenu?: React.ReactNode
    customContent?: React.ReactNode
}

type TreeProps = React.HTMLAttributes<HTMLDivElement> & {
    data: TreeDataItem[] | TreeDataItem
    initialSelectedItemId?: string
    onSelectChange?: (item: TreeDataItem | undefined) => void
    expandAll?: boolean
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    forceExpandedIds?: string[]
}

const TreeView = React.forwardRef<HTMLDivElement, TreeProps>(
    (
        {
            data,
            initialSelectedItemId,
            onSelectChange,
            expandAll,
            defaultLeafIcon,
            defaultNodeIcon,
            forceExpandedIds,
            className,
            ...props
        },
        ref
    ) => {
        const [selectedItemId, setSelectedItemId] = React.useState<
            string | undefined
        >(initialSelectedItemId)

        const handleSelectChange = React.useCallback(
            (item: TreeDataItem | undefined) => {
                setSelectedItemId(item?.id)
                if (onSelectChange) {
                    onSelectChange(item)
                }
            },
            [onSelectChange]
        )

        const expandedItemIds = React.useMemo(() => {
            const ids: string[] = [...(forceExpandedIds || [])]

            if (!initialSelectedItemId) {
                return ids
            }

            function walkTreeItems(
                items: TreeDataItem[] | TreeDataItem,
                targetId: string
            ) {
                if (Array.isArray(items)) {
                    for (let i = 0; i < items.length; i++) {
                        ids.push(items[i].id)
                        if (walkTreeItems(items[i], targetId) && !expandAll) {
                            return true
                        }
                        if (!expandAll) ids.pop()
                    }
                } else if (!expandAll && items.id === targetId) {
                    return true
                } else if (items.children) {
                    return walkTreeItems(items.children, targetId)
                }
            }

            walkTreeItems(data, initialSelectedItemId)
            return ids
        }, [data, expandAll, initialSelectedItemId, forceExpandedIds])

        return (
            <div className={cn("overflow-hidden relative", className)}>
                <TreeItem
                    data={data}
                    ref={ref}
                    selectedItemId={selectedItemId}
                    handleSelectChange={handleSelectChange}
                    expandedItemIds={expandedItemIds}
                    defaultLeafIcon={defaultLeafIcon}
                    defaultNodeIcon={defaultNodeIcon}
                    level={0}
                    {...props}
                />
            </div>
        )
    }
)
TreeView.displayName = "TreeView"

type TreeItemProps = TreeProps & {
    selectedItemId?: string
    handleSelectChange: (item: TreeDataItem | undefined) => void
    expandedItemIds: string[]
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    level?: number
}

const TreeItem = React.forwardRef<HTMLDivElement, TreeItemProps>(
    (
        {
            className,
            data,
            selectedItemId,
            handleSelectChange,
            expandedItemIds,
            defaultNodeIcon,
            defaultLeafIcon,
            level,
            ...props
        },
        ref
    ) => {
        if (!Array.isArray(data)) {
            data = [data]
        }
        return (
            <div ref={ref} role="tree" className={className} {...props}>
                <ul>
                    {data.map((item) => {
                        const itemContent = item.children ? (
                            <TreeNode
                                item={item}
                                level={level ?? 0}
                                selectedItemId={selectedItemId}
                                expandedItemIds={expandedItemIds}
                                handleSelectChange={handleSelectChange}
                                defaultNodeIcon={defaultNodeIcon}
                                defaultLeafIcon={defaultLeafIcon}
                            />
                        ) : (
                            <TreeLeaf
                                item={item}
                                selectedItemId={selectedItemId}
                                handleSelectChange={handleSelectChange}
                                defaultLeafIcon={defaultLeafIcon}
                            />
                        )

                        return (
                            <li key={item.id}>
                                {item.contextMenu ? (
                                    <ContextMenu>
                                        <ContextMenuTrigger asChild>
                                            <div
                                                onContextMenu={(e) =>
                                                    e.stopPropagation()
                                                }
                                            >
                                                {itemContent}
                                            </div>
                                        </ContextMenuTrigger>
                                        {item.contextMenu}
                                    </ContextMenu>
                                ) : (
                                    itemContent
                                )}
                            </li>
                        )
                    })}
                </ul>
            </div>
        )
    }
)
TreeItem.displayName = "TreeItem"

const TreeNode = ({
    item,
    handleSelectChange,
    expandedItemIds,
    selectedItemId,
    defaultNodeIcon,
    defaultLeafIcon,
    level = 0
}: {
    item: TreeDataItem
    handleSelectChange: (item: TreeDataItem | undefined) => void
    expandedItemIds: string[]
    selectedItemId?: string
    defaultNodeIcon?: React.ComponentType<{ className?: string }>
    defaultLeafIcon?: React.ComponentType<{ className?: string }>
    level?: number
}) => {
    const [value, setValue] = React.useState(
        expandedItemIds.includes(item.id) ? [item.id] : []
    )
    // Track if user has manually interacted with this folder
    const [userInteracted, setUserInteracted] = React.useState(false)

    // Update expansion state when expandedItemIds changes, but only if user hasn't manually collapsed
    React.useEffect(() => {
        if (
            !userInteracted &&
            expandedItemIds.includes(item.id) &&
            !value.includes(item.id)
        ) {
            setValue([item.id])
        }
    }, [expandedItemIds, item.id, value, userInteracted])

    const handleValueChange = React.useCallback((newValue: string[]) => {
        setUserInteracted(true)
        setValue(newValue)
    }, [])

    const isSelected = selectedItemId === item.id
    const isOpen = value.includes(item.id)

    return (
        <AccordionPrimitive.Root
            type="multiple"
            value={value}
            onValueChange={handleValueChange}
        >
            <AccordionPrimitive.Item value={item.id}>
                <AccordionTrigger
                    className={cn(
                        treeVariants(),
                        isSelected && selectedTreeVariants()
                    )}
                    onClick={() => {
                        handleSelectChange(item)
                        item.onClick?.()
                    }}
                >
                    <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200 text-zinc-400 -mr-3.5" />
                    <TreeIcon
                        item={item}
                        isSelected={isSelected}
                        isOpen={isOpen}
                        default={defaultNodeIcon}
                    />
                    <span className="text-sm truncate text-zinc-300">
                        {item.name}
                    </span>
                </AccordionTrigger>
                <AccordionContent className="ml-4 pl-1 border-l border-white/5">
                    <TreeItem
                        data={item.children ? item.children : item}
                        selectedItemId={selectedItemId}
                        handleSelectChange={handleSelectChange}
                        expandedItemIds={expandedItemIds}
                        defaultLeafIcon={defaultLeafIcon}
                        defaultNodeIcon={defaultNodeIcon}
                        level={level + 1}
                    />
                </AccordionContent>
            </AccordionPrimitive.Item>
        </AccordionPrimitive.Root>
    )
}

const TreeLeaf = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
        item: TreeDataItem
        selectedItemId?: string
        handleSelectChange: (item: TreeDataItem | undefined) => void
        defaultLeafIcon?: React.ComponentType<{ className?: string }>
    }
>(
    (
        {
            className,
            item,
            selectedItemId,
            handleSelectChange,
            defaultLeafIcon,
            ...props
        },
        ref
    ) => {
        const isSelected = selectedItemId === item.id

        // If customContent is provided, render it directly
        if (item.customContent) {
            return <div ref={ref}>{item.customContent}</div>
        }

        return (
            <div
                ref={ref}
                className={cn(
                    "flex text-left items-center py-0.5 cursor-pointer before:right-1",
                    treeVariants(),
                    className,
                    isSelected && selectedTreeVariants()
                )}
                onClick={() => {
                    handleSelectChange(item)
                    item.onClick?.()
                }}
                {...props}
            >
                <TreeIcon
                    item={item}
                    isSelected={isSelected}
                    default={defaultLeafIcon}
                />
                <span className="ml-0.5 grow text-sm truncate text-zinc-300">
                    {item.name}
                </span>
            </div>
        )
    }
)
TreeLeaf.displayName = "TreeLeaf"

const AccordionTrigger = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
    <AccordionPrimitive.Header>
        <AccordionPrimitive.Trigger
            ref={ref}
            className={cn(
                "flex flex-1 w-full items-center py-0.5 transition-all first:[&[data-state=open]>svg]:first-of-type:rotate-90",
                className
            )}
            {...props}
        >
            {children}
        </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
))
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName

const AccordionContent = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
    <AccordionPrimitive.Content
        ref={ref}
        className={cn(
            "overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
            className
        )}
        {...props}
    >
        <div className="pb-1 pt-0">{children}</div>
    </AccordionPrimitive.Content>
))
AccordionContent.displayName = AccordionPrimitive.Content.displayName

const TreeIcon = ({
    item,
    default: defaultIcon
}: {
    item: TreeDataItem
    isOpen?: boolean
    isSelected?: boolean
    default?: React.ComponentType<{ className?: string }>
}) => {
    let Icon: React.ComponentType<{ className?: string }> | undefined =
        defaultIcon
    if (item.icon) {
        Icon = item.icon
    }
    return Icon ? <Icon className="h-4 w-4 shrink-0 mr-1" /> : <></>
}

export { TreeView, type TreeDataItem }
