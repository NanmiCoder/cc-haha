import { useState } from 'react'
import { View } from 'react-native'
import type { RecentProject } from '../../core/newTask'
import {
  Button,
  FieldRow,
  Group,
  Icon,
  InlineError,
  ListRow,
  Loading,
  Mono,
  SectionHeader,
  Separator,
  Sheet,
  useColors,
} from '../kit'

/** 选项目：电脑默认目录 · 最近项目 · 手动输入路径。 */
export function ProjectPickerSheet({
  visible,
  value,
  projects,
  loading,
  error,
  onPick,
  onClose,
}: {
  visible: boolean
  value: string | null
  projects: RecentProject[]
  loading: boolean
  error: string
  onPick(path: string | null): void
  onClose(): void
}) {
  const colors = useColors()
  const known = value === null || projects.some((project) => project.realPath === value)
  const [manual, setManual] = useState(known ? '' : (value ?? ''))
  const check = (selected: boolean) =>
    selected ? <Icon name="check" size={18} color={colors.run} strokeWidth={2.4} /> : null
  const applyManual = () => {
    const path = manual.trim()
    if (path) onPick(path)
  }
  return (
    <Sheet visible={visible} onClose={onClose} title="选择项目">
      <Group>
        <ListRow
          title="电脑默认目录"
          subtitle="不指定项目，在电脑的用户目录里执行"
          trailing={check(value === null)}
          accessibilityLabel="电脑默认目录"
          onPress={() => onPick(null)}
        />
        {projects.map((project) => (
          <View key={project.realPath}>
            <Separator />
            <ListRow
              title={project.projectName}
              subtitle={
                <Mono numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
                  {project.realPath}
                </Mono>
              }
              trailing={check(value === project.realPath)}
              accessibilityLabel={project.projectName}
              onPress={() => onPick(project.realPath)}
            />
          </View>
        ))}
      </Group>
      {loading && <Loading />}
      <InlineError text={error} />
      <SectionHeader title="手动输入路径" style={{ paddingTop: 10, paddingBottom: 0 }} />
      <Group>
        <FieldRow
          label="路径"
          mono
          value={manual}
          onChangeText={setManual}
          placeholder="/Users/you/project"
          returnKeyType="done"
          onSubmitEditing={applyManual}
        />
      </Group>
      <Button
        title="使用这个路径"
        variant="secondary"
        disabled={!manual.trim()}
        onPress={applyManual}
      />
    </Sheet>
  )
}
