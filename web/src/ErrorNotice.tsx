import { Alert } from 'antd'
import { Button } from './Button'

export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return error ? <Alert type="error" showIcon message={error} action={retry && <Button onClick={retry}>重试</Button>} /> : null
}
