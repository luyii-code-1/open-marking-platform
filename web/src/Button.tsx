import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentRef } from 'react'
import { Button as AntButton, type ButtonProps } from 'antd'

// Keep the measured resting width while Ant Design inserts its loading icon.
export const Button = forwardRef<ComponentRef<typeof AntButton>, ButtonProps>(function Button({ loading, className, style, block, children, icon, size, ...props }, forwardedRef) {
  const element = useRef<ComponentRef<typeof AntButton>>(null)
  const width = useRef<number | undefined>(undefined)
  useImperativeHandle(forwardedRef, () => element.current!)
  useLayoutEffect(() => {
    if (!loading) {
      const measured = element.current?.getBoundingClientRect().width
      if (measured) width.current = measured
    }
  }, [loading, children, icon, size, block, style?.width])
  return <AntButton {...props} ref={element} block={block} loading={loading} icon={icon} size={size} aria-busy={!!loading}
    className={['omp-button', className].filter(Boolean).join(' ')}
    style={{ ...style, ...(loading && !block && style?.width === undefined && width.current ? { width: width.current } : {}) }}>{children}</AntButton>
})
