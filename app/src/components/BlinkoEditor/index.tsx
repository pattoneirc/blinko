import { observer } from "mobx-react-lite"
import Editor from "../Common/Editor"
import { RootStore } from "@/store"
import { BlinkoStore } from "@/store/blinkoStore"
import dayjs from "@/lib/dayjs"
import { useEffect, useRef, useState } from "react"
import { useMediaQuery } from "usehooks-ts"
import { NoteType } from "@shared/lib/types"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"

type IProps = {
  mode: 'create' | 'edit',
  onSended?: () => void,
  onHeightChange?: (height: number) => void,
  height?: number,
  isInDialog?: boolean,
  withoutOutline?: boolean,
  initialData?: { file?: File, text?: string },
  showTopToolbar?: boolean
}

export const BlinkoEditor = observer(({ mode, onSended, onHeightChange, isInDialog, withoutOutline, initialData, showTopToolbar = false }: IProps) => {
  const isCreateMode = mode == 'create'
  const blinko = RootStore.Get(BlinkoStore)
  const editorRef = useRef<any>(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const isPc = useMediaQuery('(min-width: 768px)')
  const [editorBroken, setEditorBroken] = useState(false)

  // 部分 Android WebView（vivo/Via 等）上 Vditor 初始化失败，表现为白色空面板、无法输入。
  // 3 秒内拿不到可编辑区域就切到纯文本框兜底。
  useEffect(() => {
    if (isPc) return
    let tries = 0
    const timer = setInterval(() => {
      tries++
      // 只认真正可见的那个编辑面（Vditor 会同时渲染 wysiwyg / ir / sv 多个隐藏面板）
      const els = Array.from(document.querySelectorAll('#global-editor .vditor-reset')) as HTMLElement[]
      const ok = els.some(e => e.offsetParent !== null && e.getAttribute('contenteditable') === 'true' && e.clientHeight > 30)
      if (ok) { clearInterval(timer); setEditorBroken(false); return }
      if (tries >= 6) { clearInterval(timer); setEditorBroken(true) }
    }, 500)
    return () => clearInterval(timer)
  }, [mode, isPc])

  const store = RootStore.Local(() => ({
    get noteContent() {
      if (isCreateMode) {
        try {
          const local = blinko.createContentStorage.value
          const blinkoContent = blinko.noteContent
          return local?.content != '' ? local?.content : blinkoContent
        } catch (error) {
          return ''
        }
      } else {
        try {
          if (!blinko.curSelectedNote) return '';
          const local = blinko.editContentStorage.list?.find(i => Number(i.id) == Number(blinko.curSelectedNote!.id))
          const blinkoContent = blinko.curSelectedNote?.content ?? ''
          return local?.content != '' ? (local?.content ?? blinkoContent) : blinkoContent
        } catch (error) {
          return ''
        }
      }
    },
    set noteContent(v: string) {
      if (isCreateMode) {
        try {
          blinko.noteContent = v
          blinko.createContentStorage.save({ content: v })
        } catch (error) {
          console.error(error)
        }
      } else {
        try {
          if (!blinko.curSelectedNote) return;
          blinko.curSelectedNote.content = v
          const hasLocal = blinko.editContentStorage.list?.find(i => Number(i.id) == Number(blinko.curSelectedNote!.id))
          if (hasLocal) {
            hasLocal.content = v
            blinko.editContentStorage.save()
          } else {
            blinko.editContentStorage.push({ content: v, id: Number(blinko.curSelectedNote!.id) })
          }
        } catch (error) {
          console.error(error)
        }
      }
    },
    get files(): any {
      if (mode == 'create') {
        const attachments = blinko.createAttachmentsStorage.list
        if (attachments.length) {
          return (attachments)
        } else {
          return []
        }
      } else {
        return blinko.curSelectedNote?.attachments
        // const attachments = blinko.editAttachmentsStorage.list.filter(i => Number(i.id) == Number(blinko.curSelectedNote!.id))
        // if (attachments?.length) {
        //   return attachments
        // } else {
        //   return blinko.curSelectedNote?.attachments
        // }
      }
    }
  }))

  useEffect(() => {
    blinko.isCreateMode = mode == 'create'
    if (mode == 'create') {
      if (isInDialog) {
        document.documentElement.style.setProperty('--min-editor-height', `50vh`)
      }
      const local = blinko.createContentStorage.value
      if (local && local.content != '') {
        blinko.noteContent = local.content
      }
    } else {
      document.documentElement.style.setProperty('--min-editor-height', `unset`)
      try {
        if (!blinko.curSelectedNote) return;
        const local = blinko.editContentStorage.list?.find(i => Number(i.id) == Number(blinko.curSelectedNote!.id))
        if (local && local?.content != '') {
          blinko.curSelectedNote.content = local.content
        }
      } catch (error) {
        console.error(error)
      }
    }
  }, [mode])

  // Use Tauri hotkey hook


  const fallbackSend = async () => {
    const content = (store.noteContent || '').trim()
    if (!content) return
    if (isCreateMode) {
      // @ts-ignore
      await blinko.upsertNote.call({ type: blinko.noteTypeDefault, content, references: [], attachments: [], refresh: false })
      blinko.createContentStorage.clear()
      blinko.createAttachmentsStorage.clear()
      blinko.updateTicker++
    } else {
      if (!blinko.curSelectedNote) return
      // @ts-ignore
      await blinko.upsertNote.call({ id: blinko.curSelectedNote.id, type: blinko.curSelectedNote.type, content, references: [], attachments: [], refresh: true })
      blinko.updateTicker++
    }
    onSended?.()
  }

  if (editorBroken) {
    return (
      <div className="h-full flex flex-col" id='global-editor'>
        <textarea
          className="flex-1 w-full resize-none bg-background text-foreground p-3 outline-none"
          style={{ minHeight: '45vh' }}
          placeholder="我有一个新想法..."
          value={store.noteContent}
          onChange={e => { store.noteContent = e.target.value }}
        />
        <div className="flex justify-end p-2 border-t border-border">
          <button
            className="px-4 py-2 rounded-full bg-primary text-primary-foreground font-bold"
            onClick={fallbackSend}
          >发送</button>
        </div>
      </div>
    )
  }

  return <div className={`h-full flex flex-col ${withoutOutline ? '' : ''}`} ref={editorRef} id='global-editor' data-tauri-drag-region onClick={() => {
    blinko.isCreateMode = mode == 'create'
  }}>
    <Editor
      mode={mode}
      originFiles={store.files}
      originReference={!isCreateMode ? blinko.curSelectedNote?.references?.map(i => i.toNoteId) : []}
      content={store.noteContent}
      onChange={v => {
        store.noteContent = v
      }}
      withoutOutline={withoutOutline}
      initialData={initialData}
      showTopToolbar={showTopToolbar}
      onHeightChange={() => {
        onHeightChange?.(editorRef.current?.clientHeight ?? 75)
        if (editorRef.current) {
          const editorElement = document.getElementById('global-editor');
          if (editorElement && editorElement.children[0]) {
            //@ts-ignore
            editorElement.__storeInstance = editorElement.children[0].__storeInstance;
          }
        }
      }}
      isSendLoading={blinko.upsertNote.loading.value}
      bottomSlot={
        isCreateMode ? <div className='text-xs text-ignore ml-2'>Drop to upload files</div> :
          blinko.curSelectedNote?.createdAt ? <div className='text-xs text-desc'>{dayjs(blinko.curSelectedNote.createdAt).format("YYYY-MM-DD hh:mm:ss")}</div> : null
      }
      onSend={async ({ files, references, noteType, metadata }) => {
        if (isCreateMode) {
          console.log("createMode", files, references, noteType, metadata)
          //@ts-ignore
          await blinko.upsertNote.call({ type: noteType, references, refresh: false, content: blinko.noteContent, attachments: files.map(i => { return { name: i.name, path: i.uploadPath, size: i.size, type: i.type } }), metadata })
          blinko.createAttachmentsStorage.clear()
          blinko.createContentStorage.clear()
          if (blinko.noteTypeDefault == NoteType.NOTE && searchParams.get('path') != 'notes') {
            await navigate('/?path=notes')
            blinko.forceQuery++
          }
          if (blinko.noteTypeDefault == NoteType.BLINKO && location.pathname != '/') {
            await navigate('/')
            blinko.forceQuery++
          }
          blinko.updateTicker++
        } else {
          if (!blinko.curSelectedNote) return;
          await blinko.upsertNote.call({
            id: blinko.curSelectedNote.id,
            type: noteType,
            //@ts-ignore
            content: blinko.curSelectedNote.content,
            //@ts-ignore
            attachments: files.map(i => { return { name: i.name, path: i.uploadPath, size: i.size, type: i.type } }),
            references,
            metadata,
            refresh: true // Ensure list is refreshed after update
          })
          try {
            const index = blinko.editAttachmentsStorage.list?.findIndex(i => i.id == blinko.curSelectedNote!.id)
            if (index != -1) {
              blinko.editAttachmentsStorage.remove(index)
              blinko.editContentStorage.remove(index)
            }
          } catch (error) {
            console.error(error)
          }
        }
        onSended?.()
      }} />
  </div>
})


