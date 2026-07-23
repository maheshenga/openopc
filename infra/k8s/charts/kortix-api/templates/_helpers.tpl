{{- define "kortix-api.name" -}}
kortix-api
{{- end -}}

{{- define "kortix-api.labels" -}}
app.kubernetes.io/name: {{ include "kortix-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix
{{- end -}}

{{- define "kortix-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kortix-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kortix-api.studioWorkerName" -}}
kortix-studio-worker
{{- end -}}

{{- define "kortix-api.studioWorkerLabels" -}}
app.kubernetes.io/name: {{ include "kortix-api.studioWorkerName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kortix
app.kubernetes.io/component: studio-worker
{{- end -}}

{{- define "kortix-api.studioWorkerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "kortix-api.studioWorkerName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: studio-worker
{{- end -}}

{{- define "kortix-api.image" -}}
{{- if .Values.image.digest -}}
{{ printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end -}}
{{- end -}}
