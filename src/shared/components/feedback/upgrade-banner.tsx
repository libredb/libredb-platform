interface UpgradeBannerProps {
  feature: string
  message?: string
}

export function UpgradeBanner({ feature, message }: UpgradeBannerProps) {
  return (
    <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 p-8 text-center">
      <p className="text-sm font-medium text-amber-600">
        {message ?? `Upgrade your plan to access ${feature}`}
      </p>
    </div>
  )
}
