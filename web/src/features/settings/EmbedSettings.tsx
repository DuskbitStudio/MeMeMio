import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import {
  fetchEmbedConfig,
  putEmbedConfig,
  testEmbedConfig,
  type EmbedConfig,
} from '../../lib/api-config'
import { formatDate } from '../../lib/format'
import { Alert, AlertTitle } from '../../components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { ConfigFields } from './ConfigFields'
import { SettingsCard } from './SettingsCard'
import { TestResultPanel } from './TestResultPanel'
import { describeSaveError } from './save-error'
import { EMBED_NOTICE } from './settings-copy'
import { NOTICE, TOUCH } from './settings-ui'
import { embedNotes, embedProbes } from './test-probes'
import { useConfigForm } from './use-config-form'

/**
 * 管理页的全站 Embedding 配置（SPEC §6.5、§9.6）。
 *
 * **不收进折叠区**：和视觉通道相反，这一组是管理员特意进来改的，藏起来没有意义；
 * 需要多一道手的地方在换模型的二次确认上。
 *
 * 换模型且库里已有数据时服务端返回 `EMBED_MODEL_CHANGED`（409），这不是错误，
 * 是要求确认。确认后带 `confirmReindex: true` 重发，服务端自动排全站重算。
 */

export function EmbedSettings({ onReindexTriggered }: { onReindexTriggered: () => void }) {
  const form = useConfigForm(testEmbedConfig)

  const [config, setConfig] = useState<EmbedConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** 服务端要求确认换模型，等用户点确认后带 confirmReindex 重发 */
  const [needsConfirm, setNeedsConfirm] = useState(false)
  /** 这一次保存有没有引发重算，来自 PUT 的回执而不是本地推断（SPEC §6.5.3） */
  const [reindexNote, setReindexNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchEmbedConfig()
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        form.load({
          baseUrl: cfg.baseUrl ?? '',
          model: cfg.model ?? '',
          apiKey: cfg.apiKey ?? '',
        })
      })
      .catch((err) => {
        if (!alive) return
        setLoadError(
          err instanceof ApiError ? `${err.message}（requestId：${err.requestId}）` : '加载失败',
        )
      })
    return () => {
      alive = false
    }
    // 只在挂载时拉一次：form 的 setter 每次渲染都是新函数，进依赖数组会变成无限循环
  }, [])

  async function save(confirmReindex: boolean) {
    setSaveError(null)
    setSaved(false)
    setReindexNote(null)
    setSaving(true)
    try {
      const updated = await putEmbedConfig(form.fields, confirmReindex)
      setConfig(updated)
      form.load({
        baseUrl: updated.baseUrl ?? '',
        model: updated.model ?? '',
        apiKey: updated.apiKey ?? '',
      })
      setNeedsConfirm(false)
      setSaved(true)
      // 以服务端的回执为准，不用「我传了 confirmReindex 所以一定排了队」去猜：
      // 库里没有向量时 reindexTriggered 为真而 reindexEnqueuedCount 为 0（SPEC §6.5.3）。
      // 它是条数不是布尔，所以判真值写 `> 0`；这个数是**那一次保存**的记账，
      // 和下方进度条里会被 worker 和并发触发改写的 stale 不是一个东西。
      setReindexNote(
        updated.reindexTriggered
          ? updated.reindexEnqueuedCount > 0
            ? `已换模型，全站重建索引已排队 ${updated.reindexEnqueuedCount} 条，进度见下方。`
            : '已换模型。库里还没有向量，没有需要重算的记录。'
          : null,
      )
      if (updated.reindexEnqueuedCount > 0) onReindexTriggered()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMBED_MODEL_CHANGED') {
        // 不是失败，是要求确认（SPEC §6.5.2）
        setNeedsConfirm(true)
        return
      }
      const view = describeSaveError(err)
      if (view.retest) form.resetTest()
      setSaveError(view.text)
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || form.phase.kind === 'testing'

  return (
    <SettingsCard
      title="Embedding 模型（全站）"
      description="检索用的向量由它生成。这份配置对所有用户生效，换掉它要重算全库。"
      action={<Badge>全站生效</Badge>}
    >
      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>{loadError}</AlertTitle>
        </Alert>
      )}
      {!loadError && !config && <p className="text-sm text-muted-foreground">加载中…</p>}

      {config && (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              当前生效：{config.source === 'user' ? '管理员配置的' : '部署方环境变量里的'}
            </p>
            {config.model && <p className="font-mono text-xs text-muted-foreground">{config.model}</p>}
            <p className="text-sm text-muted-foreground">
              {config.verifiedAt
                ? `上次测试通过：${formatDate(config.verifiedAt)}`
                : '这组配置还没通过过测试'}
              {config.nativeDim !== null && <>　实测维度 {config.nativeDim}</>}
            </p>
          </div>

          {/* 契约文案，逐字（SPEC §9.9） */}
          <pre className={NOTICE}>{EMBED_NOTICE}</pre>

          <ConfigFields
            idPrefix="embed"
            fields={form.fields}
            maskedApiKey={config.apiKey}
            disabled={busy}
            onChange={form.setField}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className={TOUCH}
              onClick={form.test}
              disabled={busy}
            >
              {form.phase.kind === 'testing' ? '测试中…' : '测试连接'}
            </Button>
            <Button
              type="button"
              className={TOUCH}
              onClick={() => save(false)}
              disabled={!form.tested || busy}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>

          {!form.tested && (
            <p className="text-sm text-muted-foreground">
              测试通过后才能保存。改了任一字段都要重新测。
            </p>
          )}

          {form.phase.kind === 'failed' && (
            <Alert variant="destructive">
              <AlertTitle>
                {form.phase.message}
                {form.phase.requestId && `（requestId：${form.phase.requestId}）`}
              </AlertTitle>
            </Alert>
          )}

          {form.phase.kind === 'done' && (
            <TestResultPanel
              ok={form.phase.result.ok}
              probes={embedProbes(form.phase.result)}
              notes={embedNotes(form.phase.result)}
              rawError={form.phase.result.rawError}
            />
          )}

          {saveError && (
            <Alert variant="destructive">
              <AlertTitle>{saveError}</AlertTitle>
            </Alert>
          )}
          {saved && (
            <p role="status" className="text-sm">
              已保存
            </p>
          )}
          {reindexNote && (
            <p role="status" className="text-sm">
              {reindexNote}
            </p>
          )}
        </>
      )}

      {/*
        换模型的二次确认。原来是表单下面一块内联的 role="alertdialog"，
        现在是一个真正的模态 AlertDialog：这一下会动全库，值得打断一次。
        （§8 那条「不要做成模态阻塞」说的是**重建进度**，它是下面那张独立的卡。）
        确认后对话框就关掉，失败原因显示在上面的卡里——不让用户对着一个关不掉的框找原因。
      */}
      <AlertDialog open={needsConfirm} onOpenChange={setNeedsConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>换掉 Embedding 模型？</AlertDialogTitle>
            <AlertDialogDescription>
              {/* 冒号写成表达式：跟在一段标签后面换行写，读数时很难确认它有没有被并进上一行 */}
              {'换掉 Embedding 模型会触发'}
              <strong>全站重新索引</strong>
              {'：库里已有的向量属于旧模型，要按新模型全部重算一遍。'}
              <br />
              重算期间搜索降级为 OCR + 标签，结果会带「可能不全」的提示，但服务不中断。
            </AlertDialogDescription>

          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving} className={TOUCH}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction disabled={saving} className={TOUCH} onClick={() => save(true)}>
              {saving ? '提交中…' : '确认更换并开始重建'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
