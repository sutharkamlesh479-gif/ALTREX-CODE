import appLogoUrl from '../../../assets/branding/altrex-app-icon.png'
import codeSymbolUrl from '../../../assets/branding/altrex-code-symbol.png'

type BrandAssetProps = {
  size?: number
  className?: string
}

export function AltrexLogo({ size = 24, className = '' }: BrandAssetProps): React.JSX.Element {
  return (
    <img
      className={`altrex-logo ${className}`}
      src={appLogoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

export function AltrexCodeSymbol({ size = 52, className = '' }: BrandAssetProps): React.JSX.Element {
  return (
    <img
      className={`altrex-code-symbol ${className}`}
      src={codeSymbolUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

