import { h, Component } from 'preact'
import { Button } from '@onfido/castor-react'
import classNames from 'classnames'
import { preventDefaultOnClick } from '~utils'
import { performHttpReq } from '~utils/http'
import { formatError } from '~utils/onfidoApi'
import { createSocket } from '~utils/crossDeviceSync'
import Spinner from '../../Spinner'
import CopyLink from './CopyLink'
import PhoneNumberInputLazy from '../../PhoneNumberInput/Lazy'
import QRCodeGenerator from '../../QRCode'
import QRCodeHowTo from '../../QRCode/HowTo'
import Error from '../../Error'
import PageTitle from '../../PageTitle'
import {
  trackComponent,
  sendEvent,
  TRACKED_EVENT_TYPES,
} from '../../../Tracker'
import { localised } from '../../../locales'
import theme from '../../Theme/style.scss'
import style from './style.scss'

const SECURE_LINK_VIEWS = [
  {
    id: 'qr_code',
    className: 'qrCodeLinkOption',
    label: 'get_link.link_qr',
    subtitle: 'get_link.subtitle_qr',
  },
  {
    id: 'sms',
    className: 'smsLinkOption',
    label: 'get_link.link_sms',
    subtitle: 'get_link.subtitle_sms',
  },
  {
    id: 'copy_link',
    className: 'copyLinkOption',
    label: 'get_link.link_url',
    subtitle: 'get_link.subtitle_url',
  },
]

const configHasInvalidViewIds = (viewIdsInConfig) => {
  const validViewIds = new Set(SECURE_LINK_VIEWS.map(({ id }) => id))
  const invalidViewIds = viewIdsInConfig.filter(
    (viewId) => !validViewIds.has(viewId)
  )
  if (invalidViewIds.length > 0) {
    console.warn(
      'Default settings applied. Invalid properties in _crossDeviceLinkMethods option:',
      invalidViewIds.join(', ')
    )
    console.warn(
      '_crossDeviceLinkMethods must be an array with at least 1 of the following option: "qr_code", "copy_link", "sms"'
    )
    return true
  }
  return false
}

const validatesViewIdWithFallback = (viewId) => {
  const validViewIds = SECURE_LINK_VIEWS.map(({ id }) => id)

  if (validViewIds.includes(viewId)) {
    return viewId
  }

  return 'qr_code'
}

class SmsError extends Component {
  componentDidMount() {
    const errorName = this.props.error.name.toLowerCase()
    this.props.trackScreen([errorName])
  }
  render = ({ error }) => <Error role="alert" {...{ error }} />
}

class CrossDeviceLink extends Component {
  constructor(props) {
    super(props)

    if (!props.socket) {
      const url = props.urls.sync_url
      const socket = createSocket(url)
      socket.on('connect', () => {
        const roomId = this.props.roomId || null
        socket.emit('join', { roomId })
      })
      socket.on('joined', this.onJoined)
      socket.open()
      props.actions.setSocket(socket)
    }
  }

  componentDidMount() {
    this.listen(this.props.socket)
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.socket !== this.props.socket) {
      this.unlisten(this.props.socket)
      this.listen(nextProps.socket)
    }
  }

  componentWillUnmount() {
    this.unlisten(this.props.socket)
  }

  unlisten = (socket) => {
    if (!socket) return
    socket.off('get config', this.onGetConfig)
    socket.off('client success', this.onClientSuccess)
  }

  listen = (socket) => {
    if (!socket) return
    socket.on('get config', this.onGetConfig)
    socket.on('client success', this.onClientSuccess)
  }

  onJoined = (data) => {
    const { actions, roomId } = this.props
    if (!roomId) {
      actions.setRoomId(data.roomId)
    }
  }

  onGetConfig = (data) => {
    const { roomId, mobileConfig, socket, actions, nextStep } = this.props
    if (roomId && roomId !== data.roomId) {
      socket.emit('leave', { roomId })
    }
    actions.mobileConnected(true)
    this.sendMessage('config', data.roomId, mobileConfig)
    nextStep()
  }

  onClientSuccess = () => {
    const { actions } = this.props
    actions.setClientSuccess(true)
    this.props.nextStep()
  }

  sendMessage = (event, roomId, payload) => {
    this.props.socket.emit('message', { event, payload, roomId })
  }

  render = () =>
    this.props.roomId ? <CrossDeviceLinkUI {...this.props} /> : <Spinner />
}

class CrossDeviceLinkUI extends Component {
  constructor(props) {
    super(props)

    const documentStep = props.steps.find(({ type }) => type === 'document')
    const restrictedCrossDeviceLinkMethods = props._crossDeviceLinkMethods || []
    const initialViewId =
      restrictedCrossDeviceLinkMethods[0] ||
      documentStep?.options?._initialCrossDeviceLinkView
    this.state = {
      currentViewId: validatesViewIdWithFallback(initialViewId),
      sending: false,
      error: {},
      validNumber: true,
    }
  }

  linkId = `${process.env.BASE_32_VERSION}${this.props.roomId}`

  setError = (name) => this.setState({ error: { name, type: 'error' } })

  clearErrors = () => {
    this.clearSendLinkClickTimeout()
    this.setState({
      error: {},
      validNumber: true,
    })
  }

  handleResponse = (response) => {
    this.clearSendLinkClickTimeout()
    this.setState({ sending: false })
    if (response.status === 'OK') {
      this.props.nextStep()
    } else {
      this.setError('SMS_FAILED')
    }
  }

  handleSMSError = (error) => {
    this.clearSendLinkClickTimeout()
    this.setState({ sending: false })
    this.props.triggerOnError(error)
    status === 429 ? this.setError('SMS_OVERUSE') : this.setError('SMS_FAILED')
  }

  handleSendSmsLinkClick = () => {
    if (!this.props.sms.valid) {
      this.clearSendLinkClickTimeout()
      this.setState({ validNumber: false })
    } else if (!this.sendLinkClickTimeoutId) {
      this.sendLinkClickTimeoutId = setTimeout(this.sendSms, 500)
    }
  }

  sendSms = () => {
    this.setState({ sending: true })
    // add a quick note that this will send a production SMS, so non-production
    // environment users will need to amend any URLs that they receive.
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.NODE_ENV === 'development'
    ) {
      alert(
        `An SMS will be sent, but the link in it will be to production, not to ${window.location.origin}`
      )
    }
    // On staging, inform devs that sms will not be sent and link must be copy-pasted
    if (process.env.NODE_ENV === 'staging') {
      alert(
        `No SMS will be sent, please copy this link ${window.location.origin}`
      )
    }

    const { language, sms, token, urls } = this.props
    const url = urls.telephony_url
    const options = {
      // TODO: change this to pass entire language string once telephony service supports language region
      payload: JSON.stringify({
        to: sms.number,
        id: this.linkId,
        language: language.substring(0, 2),
      }),
      endpoint: `${url}/v1/cross_device_sms`,
      contentType: 'application/json',
      token: `Bearer ${token}`,
    }
    performHttpReq(options, this.handleResponse, (request) =>
      formatError(request, this.handleSMSError)
    )
  }

  getMobileUrl = () => {
    const { hosted_sdk_url, cross_device_url } = this.props.urls
    const mobileUrl = cross_device_url || hosted_sdk_url
    // This lets us test the cross device flow locally and on Surge.
    // We use the same location to test the same bundle as the desktop flow.
    return process.env.MOBILE_URL === '/'
      ? `${window.location.origin}?link_id=${this.linkId}`
      : `${mobileUrl}/${this.linkId}`
  }

  clearSendLinkClickTimeout() {
    if (this.sendLinkClickTimeoutId) {
      clearTimeout(this.sendLinkClickTimeoutId)
    }
  }

  renderSmsLinkSection = () => {
    const { translate } = this.props
    const { sending, validNumber } = this.state
    const buttonCopyKey = sending
      ? 'get_link.loader_sending'
      : 'get_link.button_submit'
    const invalidNumber = !validNumber
    return (
      <div>
        <div className={style.smsSection}>
          <div className={style.label}>
            {translate('get_link.number_field_label')}
          </div>
          <div className={style.numberInputSection}>
            <div
              className={classNames(style.inputContainer, {
                [style.fieldError]: invalidNumber,
              })}
            >
              <PhoneNumberInputLazy
                {...this.props}
                clearErrors={this.clearErrors}
              />
            </div>
            <Button
              variant="primary"
              className={classNames(style.btn, { [style.sending]: sending })}
              onClick={this.handleSendSmsLinkClick}
              disabled={sending || invalidNumber}
              aria-busy={sending}
              aria-live="polite"
              aria-relevant="text"
              data-onfido-qa="cross-device-send-link-btn"
            >
              {translate(buttonCopyKey)}
            </Button>
          </div>
        </div>
        <div role="alert" hidden={!invalidNumber}>
          {invalidNumber && (
            <div className={style.numberError}>
              {translate('get_link.alert_wrong_number')}
            </div>
          )}
        </div>
      </div>
    )
  }

  renderCopyLinkSection = () => <CopyLink mobileUrl={this.getMobileUrl()} />

  renderQrCodeSection = () => (
    <div className={style.qrCodeSection}>
      <div
        className={style.qrCodeContainer}
        role="img"
        aria-label="QR code image"
      >
        <QRCodeGenerator url={this.getMobileUrl()} size={144} />
      </div>
      <QRCodeHowTo />
    </div>
  )

  handleViewOptionSelect = (newViewId) => {
    sendEvent(
      `${newViewId.replace('_', ' ')} selected`,
      TRACKED_EVENT_TYPES.action
    )
    this.setState({ currentViewId: newViewId })
    this.viewOptionBtn.blur()
  }

  getRequiredViewRenders = () => {
    const { _crossDeviceLinkMethods = [] } = this.props
    const defaultViewRendersMap = {
      qr_code: this.renderQrCodeSection,
      sms: this.renderSmsLinkSection,
      copy_link: this.renderCopyLinkSection,
    }
    if (
      _crossDeviceLinkMethods.length < 1 ||
      configHasInvalidViewIds(_crossDeviceLinkMethods)
    ) {
      return defaultViewRendersMap
    }

    const requiredViewRendersMap = _crossDeviceLinkMethods.reduce(
      (result, viewId) => {
        result[viewId] = defaultViewRendersMap[viewId]
        return result
      },
      {}
    )
    return requiredViewRendersMap
  }

  getVisibleViewOptions = (requiredViewRenders) => {
    const { _crossDeviceLinkMethods } = this.props
    if (
      _crossDeviceLinkMethods?.length &&
      !configHasInvalidViewIds(_crossDeviceLinkMethods)
    ) {
      return _crossDeviceLinkMethods.map((viewId) =>
        SECURE_LINK_VIEWS.find((view) => view.id === viewId)
      )
    }
    return SECURE_LINK_VIEWS.filter((view) => view.id in requiredViewRenders)
  }

  componentWillUnmount() {
    this.clearSendLinkClickTimeout()
  }

  render() {
    const { translate, trackScreen } = this.props
    const { error, currentViewId } = this.state
    const requiredViewRenders = this.getRequiredViewRenders()
    const currentViewRender = requiredViewRenders[currentViewId]
    const visibleViewOptions = this.getVisibleViewOptions(requiredViewRenders)

    return (
      <div className={style.container}>
        {error.type ? (
          <SmsError error={error} trackScreen={trackScreen} />
        ) : (
          <PageTitle
            title={translate('get_link.title')}
            subTitle={translate(
              visibleViewOptions.find(({ id }) => id === currentViewId).subtitle
            )}
          />
        )}
        <div className={style.secureLinkView}>
          <div
            role="region"
            id="selectedLinkView"
            className={style.selectedLinkView}
          >
            {currentViewRender()}
          </div>
          {visibleViewOptions.length > 1 && (
            <div role="heading" aria-level="2" className={style.styledLabel}>
              {translate('get_link.link_divider')}
            </div>
          )}
          <div
            className={style.viewOptionsGroup}
            aria-controls="selectedLinkView"
          >
            {visibleViewOptions
              .filter((view) => view.id !== currentViewId)
              .map((view) => (
                <a
                  href="#"
                  className={classNames(
                    theme.link,
                    style.viewOption,
                    style[view.className]
                  )}
                  ref={(node) => (this.viewOptionBtn = node)}
                  onClick={preventDefaultOnClick(() =>
                    this.handleViewOptionSelect(view.id)
                  )}
                  key={`view_${view.id}`}
                >
                  {translate(view.label)}
                </a>
              ))}
          </div>
        </div>
      </div>
    )
  }
}

export default trackComponent(localised(CrossDeviceLink), 'crossdevice_link')
