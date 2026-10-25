import { useEffect, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { cn } from '../../lib/utils'
import {
  fetchVisionConfig,
  putVisionConfig,
  testVisionConfig,
  type VisionConfig,
} from '../../lib/api-config'
import { formatDate } from '../../lib/format'
import { Alert, AlertTitle } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Separator } from '../../components/ui/separator'
import { ConfigFields } from './ConfigFields'
import { SettingsCard } from './SettingsCard'
import { TestResultPanel } from './TestResultPanel'
import { describeSaveError } from './save-error'
import { VISION_NOTICE } from './settings-copy'
import { NOTICE, TOUCH } from './settings-ui'
import { visionProbes } from './test-probes'
import { useConfigForm } from './use-config-form'

/**
 * 用户设置页的视觉通道配置（SPEC §6.5、§9.3）。
 *
 * **整组收进默认折叠的「高级选项」，这个折叠是有意的**：改错了会污染所有人的搜索结果，
 * 所以要多一个动作才能碰到它（settings-ux.md §3）。
 *
 * 「当前生效」那一行放在折叠区外面——用户不展开也该知道自己用的是哪一套。
 *
 * 本任务不做**副通道**的表单（任务「明确不做」）。VISION_NOTICE 里提到副通道的那一句
 * 按契约逐字保留，未自行删改。
 */

function sourceLabel(source: VisionConfig['source']): string {
  return source === 'user' ? '你自己的配置' : '部署方的默认配置'
}

export function VisionSettings() {
  const form = useConfigForm(testVisionConfig)

  const [config, setConfig] = useState<VisionConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** 高级选项的展开态。**默认 false，见文件头**。 */
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    let alive = true
    fetchVisionConfig()
      .then((cfg) => {
        if (!alive) return
        setConfig(cfg)
        form.load({
          baseUrl: cfg.baseUrl ?? '',
          model: cfg.model ?? '',
          // 脱敏串原样留在表单里就等于「不修改」（SPEC §3.5）
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

  async function handleSave() {
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      const updated = await putVisionConfig(form.fields)
      setConfig(updated)
      form.load({
        baseUrl: updated.baseUrl ?? '',
        model: updated.model ?? '',
        apiKey: updated.apiKey ?? '',
      })
      setSaved(true)
    } catch (err) {
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
      title="视觉打标模型"
      description="你导入的图片由这组模型打标。不填就用部署方的默认配置，那是经过验证的。"
      action={
        config && <Badge variant="secondary">{sourceLabel(config.source)}</Badge>
      }
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
            {config.model && <p className="font-mono text-xs text-muted-foreground">{config.model}</p>}
            <p className="text-sm text-muted-foreground">
              {config.verifiedAt
                ? `上次测试通过：${formatDate(config.verifiedAt)}`
                : '这组配置还没通过过测试'}
            </p>
          </div>

          <Separator />

          {/*
            折叠开关**没有用 shadcn 的 Accordion**，这是一个定过的取舍：
            `AccordionContent` 的内层 div 是 `h-(--radix-accordion-content-height)`，
            而那个变量是 radix **在展开那一刻量一次的快照**（`useLayoutEffect` 依赖
            `[open, present]`，全程没有 ResizeObserver）。外层又是 `overflow-hidden`。
            这个折叠区里要长出测试结果、报错、已保存提示——**展开之后再出现的内容会被裁掉，
            而且不报任何错**。RawOutput 那边装的是静态字符串，所以那里可以用 Accordion。
            行为不变：默认收起、要多一个动作才碰到（settings-ux.md §3）。
          */}
          <div className="flex flex-col gap-4">
            <Button
              type="button"
              variant="outline"
              className={cn(TOUCH, 'self-start')}
              aria-expanded={advanced}
              aria-controls="vision-advanced"
              onClick={() => setAdvanced((v) => !v)}
            >
              高级选项：换成我自己的视觉模型
              <ChevronDownIcon
                aria-hidden="true"
                data-icon="inline-end"
                className={cn('transition-transform', advanced && 'rotate-180')}
              />
            </Button>

            {advanced && (
              <div id="vision-advanced" className="flex flex-col gap-4 rounded-2xl border p-4">
                {/* 契约文案，逐字（SPEC §9.9）。渲染成 <pre> 以保留它的分段结构 */}
                <pre className={NOTICE}>{VISION_NOTICE}</pre>

                {/*
                  上面那段契约文案里提到「副通道」，但这一版没有对应的输入框。
                  这一行**在 <pre> 之外**，是界面现状说明，不是契约文案的一部分——
                  它解释用户为什么找不到那个框，不改变上面一个字。§9.5 落地后删掉这一行。
                */}
                <p className="text-sm text-muted-foreground">副通道的配置入口尚未开放。</p>

                <ConfigFields
                  idPrefix="vision"
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
                    onClick={handleSave}
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
                    probes={visionProbes(form.phase.result)}
                    rawResponse={form.phase.result.rawResponse}
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
              </div>
            )}
          </div>
        </>
      )}
    </SettingsCard>
  )
}
