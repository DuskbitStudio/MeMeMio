import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import {
  fetchImageEmbedConfig,
  putImageEmbedConfig,
  testImageEmbedConfig,
  type ImageEmbedConfig,
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
import { IMAGE_EMBED_NOTICE } from './settings-copy'
import { NOTICE, TOUCH } from './settings-ui'
import { imageEmbedNotes, imageEmbedProbes } from './test-probes'
import { useConfigForm } from './use-config-form'

/**
 * 管理页的图片向量配置（任务 §5.2、SPEC §6.7.5）。
 *
 * ## 与 `EmbedSettings` 是两张卡，不是一张卡的两个字段
 *
 * 它们看着只差一个探测项，其实是**两条独立的配置流**（§5.7.1）：各自的表、各自的
 * 测试记录、各自的降级路径。合成一张卡之后，管理员面对的就是「一次保存里有两组
 * baseUrl / model / key」——而其中一组改坏了要重算的是**全库的图**，另一组只是检索。
 * 所以这里逐条复刻 `EmbedSettings` 的形状，**不做「抽一个公共组件带参数」的合并**：
 * 合并省下的那点重复，换来的是以后每一次改动都要先想「这条对两边都成立吗」。
 *
 * ## 这一张比 embedding 那张多一句「花谁的钱」
 *
 * 图片向量是**每张图一次上游调用**（§6.7.5），文本 embedding 是一次导入算一条。
 * 所以换模型触发的重算、以及下方补跑面板那一下，都要说清条数与钱的归属——
 * 这是这一份配置里唯一会让部署方**出意外账单**的地方。
 */

/** 当前状态那一行里的图片输入结论。**三态**，见 `test-probes.ts` 里那条说明。 */
function imageInputText(value: boolean | null): string {
  if (value === null) return '图片输入：还没测过'
  return value ? '图片输入：上游确实在编码图片' : '图片输入：上次测试发现图片被丢掉了'
}

export function ImageEmbedSettings({ onReindexTriggered }: { onReindexTriggered: () => void }) {
  const form = useConfigForm(testImageEmbedConfig)

  const [config, setConfig] = useState<ImageEmbedConfig | null>(null)
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
    fetchImageEmbedConfig()
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
      const updated = await putImageEmbedConfig(form.fields, confirmReindex)
      setConfig(updated)
      form.load({
        baseUrl: updated.baseUrl ?? '',
        model: updated.model ?? '',
        apiKey: updated.apiKey ?? '',
      })
      setNeedsConfirm(false)
      setSaved(true)
      /*
        以服务端的回执为准，不用「我传了 confirmReindex 所以一定排了队」去猜：
        库里没有人物向量时 `reindexTriggered` 为真而条数为 0（SPEC §6.5.3 同形）。

        ⚠️ **这里的条数比文本那份贵得多**：每张图一次上游调用。所以文案里点出「每条
        都是一次付费调用、花的是部署方的额度」——文本那份不用交代这一句（一次导入
        算一条），这一份不交代就是让管理员在不知情的情况下签一张账单。
      */
      setReindexNote(
        updated.reindexTriggered
          ? updated.reindexEnqueuedCount > 0
            ? `已换模型，全库图片向量重建已排队 ${updated.reindexEnqueuedCount} 条，进度见下方。每条都是一次上游付费调用，花的是部署方的额度。`
            : '已换模型。库里还没有人物向量，没有需要重算的记录。'
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
      title="图片向量（全站）"
      description="人物识别与聚类靠它：每张图算一个向量，向量相近的图会被归到同一个人物。这份配置对所有用户生效，换掉它要重算全库。"
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
            {/*
              ⚠️ **部署方默认值那一支永远是「还没测过」**（`getImageEmbedConfig` 的注释）：
              那一套没有测试记录，不能因为「这是我们自己配的」就假设它支持什么。
              所以这句话不判 `source`，它按 `imageInputWorks` 说实话。
            */}
            <p className="text-sm text-muted-foreground">{imageInputText(config.imageInputWorks)}</p>
          </div>

          {/*
            ⚠️ 这一段**不是契约**：SPEC §9.9 还没有图片向量那一段正文，
            它是这边新写的，等总管裁定。见 `settings-copy.ts` 的文件头。
          */}
          <pre className={NOTICE}>{IMAGE_EMBED_NOTICE}</pre>

          <ConfigFields
            idPrefix="image-embed"
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
              probes={imageEmbedProbes(form.phase.result)}
              notes={imageEmbedNotes(form.phase.result)}
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
        换模型的二次确认。比文本那一份多说两句这一份独有的事：**已有的归属不动**
        （只换向量，§6.7.5）——不说的话管理员会担心「换完人物全乱了」；
        以及**这不是一笔小账**。
      */}
      <AlertDialog open={needsConfirm} onOpenChange={setNeedsConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>换掉图片向量模型？</AlertDialogTitle>
            <AlertDialogDescription>
              {'换掉图片向量模型会触发'}
              <strong>全库图片向量重建</strong>
              {'：库里已有的向量属于旧模型，要按新模型全部重算一遍。'}
              <br />
              {'每张图都是一次上游付费调用，花的是部署方的额度。'}
              <br />
              <strong>已经分好的人物和系列不受影响</strong>
              {'，重算只换向量，不会把人物打散重来。'}
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
