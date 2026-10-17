'use client'

import { ReactRenderer } from '@tiptap/react'
import tippy, { type Instance } from 'tippy.js'
import { MentionList, type MentionCandidate } from '../components/mention-list'
import { searchPlatformStaff } from '../actions/search-staff'

interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const mentionSuggestion = {
  items: async ({ query }: { query: string }): Promise<MentionCandidate[]> => {
    const res = await searchPlatformStaff({ q: query })
    if (!res.success) return []
    return res.data as MentionCandidate[]
  },
  render: () => {
    let component: ReactRenderer<MentionListRef> | null = null
    let popup: Instance[] | null = null

    return {
      onStart: (props: any) => {
        component = new ReactRenderer(MentionList as any, {
          props,
          editor: props.editor,
        })
        if (!props.clientRect) return
        popup = tippy('body', {
          getReferenceClientRect: props.clientRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        })
      },
      onUpdate(props: any) {
        component?.updateProps(props)
        if (!props.clientRect) return
        popup?.[0].setProps({ getReferenceClientRect: props.clientRect })
      },
      onKeyDown(props: any) {
        if (props.event.key === 'Escape') {
          popup?.[0].hide()
          return true
        }
        return component?.ref?.onKeyDown(props) ?? false
      },
      onExit() {
        popup?.[0].destroy()
        component?.destroy()
      },
    }
  },
}
