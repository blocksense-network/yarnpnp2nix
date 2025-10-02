{ stdenv, rsync, yarn, fetchzip, nodejs }:

stdenv.mkDerivation {
  name = "yarn-berry";
  src = builtins.fetchTarball {
    url = "https://github.com/yarnpkg/berry/archive/@yarnpkg/cli/4.9.1.tar.gz";
    sha256 = "sha256:1zjvi3c01n8q2q0nnmab7mkn86crdh0az1r7gh2b056kdvrl2z6f";
  };

  phases = [ "getSource" "patchPhase" "build" ];

  buildInputs = [
    yarn
    rsync
    nodejs
  ];

  getSource = ''
    tmpDir=$PWD
    mkdir -p $tmpDir/yarn
    shopt -s dotglob
    cp --no-preserve=mode -r $src/* $tmpDir/yarn/
    cd $tmpDir/yarn
  '';

  build = ''
    yarn build:cli
    (cd packages/yarnpkg-pnp && yarn pack -o package.tgz)
    mkdir -p $out/bin $out/packages
    mv packages/yarnpkg-cli/bundles/yarn.js $out/bin/yarn
    chmod +x $out/bin/yarn
    patchShebangs $out/bin/yarn
  '';
}
