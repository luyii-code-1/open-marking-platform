export function Brand({ compact = false, login = false }: { compact?: boolean; login?: boolean }) {
  return <div className={`brand${compact ? ' brand-collapsed' : ''}${login ? ' brand-login' : ''}`}>
    <div className="brand-logo"><img src={login ? '/branding/omp-logo.svg' : '/branding/omp-mark.svg'} alt="Open Marking Platform" width={login ? 180 : compact ? 40 : 84} height={login ? 82 : 28} /><span className="brand-commit" aria-label="Commit ID">{__OMP_BUILD__.commit}</span></div>
    {!compact && !login && <span className="brand-name">开放阅卷平台</span>}
  </div>
}
