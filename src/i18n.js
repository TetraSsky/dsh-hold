export const fallbackLocale = 'en'

export const dictionaries = {
  en: {
    buttonLabel: 'Hold',
    buttonTitle: 'Hold this message until the session is finished',
    buttonEmpty: 'Type a message first.',

    windowTitle: 'Hold this message',
    windowHint: 'The host holds it, so closing this tab does not lose it.',

    message: 'Message',
    when: 'Send at',
    whenHint: 'Optional.',
    hour: 'Hour',
    minute: 'Minute',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',

    behavior: 'If the AI is still working',
    behaviorQueue: 'Queue (Default)',
    behaviorWait: 'Wait idle',
    behaviorSteer: 'Send now (Steer)',

    create: 'Hold',
    save: 'Save',
    close: 'Close',
    edit: 'Edit',
    sendNow: 'Send now',
    remove: 'Delete',

    attachment: 'attachment',
    removeAttachment: 'Remove this attachment',
    heldCount: '{count} held messages',

    readyNow: 'Ready to send',
    waitingOn: 'Waiting on {reasons}',
    reasonTime: 'the chosen time',
    reasonAgent: 'the main agent',
    reasonAgentAbsent: 'the session to come back',
    reasonSubagents: 'a subagent',
    reasonJobs: 'a background job',

    errorInvalidDate: 'That is not a real date and time.',
    errorNotFuture: 'That time has already passed.',
    errorInvalidText: 'Type a message first.',
    errorTooLong: 'That message is too long.',
    errorInvalidSession: 'That session is not available.',
    errorInvalidId: 'That request is missing an identifier.',
    errorHoldGone: 'That held message no longer exists.',
    errorNotStored: 'The message could not be stored.',
    errorTooManyAttachments: 'That is more attachments than a hold can carry.',
    errorInvalidAttachment: 'One of those attachments cannot be held.',
    errorAttachmentTooLarge: 'Those attachments are too large to hold.',
    errorAttachmentGone: 'A staged file is no longer uploaded.',
    errorAttachmentsUnavailable: 'This host cannot hold attachments right now.',
    errorAttachmentUploading: 'A file is still uploading.',
    errorAttachmentUploadFailed: 'A file upload failed.',
    errorDeliveryFailed: 'The message could not be sent.',
    errorNoConnection: 'The composer is not connected.',
    errorGeneric: 'That did not work.',
  },
  zh: {
    buttonLabel: '暂缓',
    buttonTitle: '暂缓发送这条消息，直到会话真正结束',
    buttonEmpty: '请先输入内容。',

    windowTitle: '暂缓这条消息',
    windowHint: '由宿主端保存，关闭本标签页也不会丢失。',

    message: '内容',
    when: '发送时间',
    whenHint: '可留空。',
    hour: '时',
    minute: '分',
    previousMonth: '上个月',
    nextMonth: '下个月',

    behavior: '如果 AI 仍在工作',
    behaviorQueue: '正常排队（默认）',
    behaviorWait: '等待空闲',
    behaviorSteer: '立即发送（插话）',

    create: '暂缓',
    save: '保存',
    close: '关闭',
    edit: '编辑',
    sendNow: '立即发送',
    remove: '删除',

    attachment: '附件',
    removeAttachment: '移除该附件',
    heldCount: '已暂缓 {count} 条消息',

    readyNow: '可以发送',
    waitingOn: '等待{reasons}',
    reasonTime: '指定时间',
    reasonAgent: '主智能体',
    reasonAgentAbsent: '会话恢复',
    reasonSubagents: '子智能体',
    reasonJobs: '后台任务',

    errorInvalidDate: '这不是一个真实存在的日期时间。',
    errorNotFuture: '该时间已经过去了。',
    errorInvalidText: '请先输入内容。',
    errorTooLong: '内容过长。',
    errorInvalidSession: '该会话不可用。',
    errorInvalidId: '请求缺少必要的标识。',
    errorHoldGone: '这条暂缓消息已不存在。',
    errorNotStored: '消息未能保存。',
    errorTooManyAttachments: '附件数量超出暂缓上限。',
    errorInvalidAttachment: '其中一个附件无法暂缓。',
    errorAttachmentTooLarge: '附件过大，无法暂缓。',
    errorAttachmentGone: '暂存的文件上传已失效。',
    errorAttachmentsUnavailable: '当前宿主端无法保存附件。',
    errorAttachmentUploading: '仍有文件正在上传。',
    errorAttachmentUploadFailed: '文件上传失败。',
    errorDeliveryFailed: '消息发送失败。',
    errorNoConnection: '与宿主端的连接不可用。',
    errorGeneric: '操作失败。',
  },
}

export const translate = (locale, key, vars) => {
  const language = String(locale ?? fallbackLocale)
  const dict = dictionaries[language] ?? dictionaries[language.split('-')[0]] ?? dictionaries[fallbackLocale]
  let text = dict[key] ?? dictionaries[fallbackLocale][key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
  }
  return text
}
