; The v1 prepare/cleanup boundary, kept as a macro so both calls use the
; exact original unencoded NSIS/shell argument construction.
!macro CcHahaRunBuildHelper _MODE _ARG1 _ARG2
  !system 'node "${BUILD_RESOURCES_DIR}/../scripts/nsis-legacy-compat.cjs" ${_MODE} "${_ARG1}" "${_ARG2}"' = 0
!macroend
