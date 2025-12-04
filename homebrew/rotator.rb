cask "rotator" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.10.4"
  sha256 arm:   "REPLACE_WITH_ARM_SHA256",
         intel: "REPLACE_WITH_INTEL_SHA256"

  url "https://github.com/mgorunuch/work-rotator-app/releases/download/v#{version}/Rotator_#{version}_#{arch}.dmg"
  name "Rotator"
  desc "Work rotation timer app"
  homepage "https://github.com/mgorunuch/work-rotator-app"

  depends_on macos: ">= :catalina"

  app "Rotator.app"

  zap trash: [
    "~/Library/Application Support/com.rotator.app",
    "~/Library/Caches/com.rotator.app",
    "~/Library/Preferences/com.rotator.app.plist",
  ]
end
