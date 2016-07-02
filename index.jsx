import React from 'react'
import ReactCSSTransitionGroup from 'react-addons-css-transition-group'
import explain from 'explain-error'
import mlib from 'ssb-msgs'
import schemas from 'ssb-msg-schemas'
import threadlib from 'patchwork-threads'
import pull from 'pull-stream'
import { UserLinks } from 'patchkit-links'
import Card from 'patchkit-msg-view/card'
import Composer from 'patchkit-post-composer'
import u from 'patchkit-util'
import t from 'patchwork-translations'

class BookmarkBtn extends React.Component {
  static propTypes = {
    isBookmarked: React.PropTypes.bool,
    onClick: React.PropTypes.func.isRequired
  }

  render() {
    const b = this.props.isBookmarked
    const title = t(b?'thread.WatchingThread':'thread.WatchThread')
    const hint = t(b?'thread.WatchingHint':'thread.WatchHint')
    return <a className={'hint--bottom '+(b?' selected':'')} data-hint={hint} onClick={this.props.onClick} title={title}>
        <i className={'fa fa-'+(b?'eye':'genderless')} /> {title}
    </a>
  }
}

class UnreadBtn extends React.Component {
  static propTypes = {
    isBookmarked: React.PropTypes.bool,
    onClick: React.PropTypes.func.isRequired
  }  

  constructor(props) {
    super(props)
    this.state={marked: false}
  }

  onClick() {
    if (this.state.marked)
      return
    this.setState({marked: true})
    this.props.onClick()
  }

  render() {
    const m = this.state.marked
    return <a onClick={this.onClick.bind(this)} className="hint--bottom" data-hint={t('thread.CloseThread')}>
      <i className={"fa fa-envelope"+(m?'':'-o')} />
      {t(m?'thread.MarkedUnread':'thread.MarkUnread')}
    </a>
  }
}
            

export default class Thread extends React.Component {
  static propTypes = {
    id: React.PropTypes.string.isRequired,

    suggestOptions: React.PropTypes.object,
    channels: React.PropTypes.array,

    live: React.PropTypes.bool,
    forceRaw: React.PropTypes.bool,
    forceRootExpanded: React.PropTypes.bool,

    onDidMount: React.PropTypes.func,
    onMsgChange: React.PropTypes.func,
    onNewReply: React.PropTypes.func,
    onClose: React.PropTypes.func
  }

  static contextTypes = {
    ssb: React.PropTypes.object.isRequired,
    events: React.PropTypes.object.isRequired,
    user: React.PropTypes.object.isRequired,
    users: React.PropTypes.object.isRequired
  }

  constructor(props) {
    super(props)
    this.state = {
      thread: null,
      isLoading: true,
      isHidingHistory: true,
      numOldMsgsHidden: 0,
      flattenedMsgs: [],
      collapsedMsgs: [],
      loadError: null
    }
    this.liveStream = null
  }

  // helper to do setup on thread-change
  constructState(id) {
    const ssb = this.context.ssb

    // only construct for new threads
    if (this.state.thread && id === this.state.thread.key)
      return

    // load thread, but defer computing any knowledge
    threadlib.getPostThread(ssb, id, { isRead: false, isBookmarked: false, mentions: false, votes: false }, (err, thread) => {
      if (err)
        return console.error(err), this.setState({ loadError: err })

      // compile thread votes
      threadlib.compileThreadVotes(thread)

      // flatten *before* fetching info on replies, to make sure that info is attached to the right msg object
      var flattenedMsgs = threadlib.flattenThread(thread)
      thread.related = flattenedMsgs.slice(flattenedMsgs.indexOf(thread) + 1) // skip past the root
      threadlib.fetchThreadData(ssb, thread, { isRead: true, isBookmarked: true, mentions: true }, (err, thread) => {
        if (err)
          return this.context.events.emit('error', explain(err, 'Failed to Load Message'))

        // note which messages start out unread, so they stay collapsed or expanded during re-renders
        flattenedMsgs.forEach(m => m._isRead = m.isRead)
        flattenedMsgs[flattenedMsgs.length - 1]._isRead = false // always expand the last one

        // hide old unread messages
        // (only do it for the first unbroken chain of unreads)
        let collapsedMsgs = [].concat(flattenedMsgs)
        let numOldHidden = 0
        let startOld = collapsedMsgs.indexOf(thread) // start at the root (which isnt always first)
        if (startOld !== -1) {
          startOld += 1 // always include the root
          for (let i=startOld; i < collapsedMsgs.length - 1; i++) {
            if (collapsedMsgs[i]._isRead === false)
              break // found an unread, break here
            numOldHidden++
          }
          numOldHidden-- // always include the last old msg
          if (numOldHidden > 0)
            collapsedMsgs.splice(startOld, numOldHidden, { isOldMsgsPlaceholder: true })
        }

        // now set state
        this.setState({
          isLoading: false,
          thread: thread,
          flattenedMsgs: flattenedMsgs,
          collapsedMsgs: collapsedMsgs,
          numOldMsgsHidden: numOldHidden,
          isReplying: (this.state.thread && thread.key === this.state.thread.key) ? this.state.isReplying : false
        })

        // mark read
        if (thread.hasUnread) {
          threadlib.markThreadRead(ssb, thread, (err) => {
            if (err)
              return this.context.events.emit('error', explain(err, 'Failed to mark thread as read'))
            this.setState({ thread: thread })
          })
        }

        // listen for new replies
        if (this.props.live) {
          if (this.liveStream)
            this.liveStream(true, ()=>{}) // abort existing livestream

          pull(
            // listen for all new messages
            (this.liveStream = ssb.createLogStream({ live: true, gt: Date.now() })),
            pull.filter(obj => !obj.sync), // filter out the sync obj
            pull.asyncMap((msg, cb) => threadlib.decryptThread(ssb, msg, cb)),
            pull.drain((msg) => {
              if (!this.state.thread)
                return
              
              var c = msg.value.content
              var rels = mlib.relationsTo(msg, this.state.thread)
              // reply post to this thread?
              if (c.type == 'post' && (rels.indexOf('root') >= 0 || rels.indexOf('branch') >= 0)) {
                // add to thread and flatlist
                this.state.flattenedMsgs.push(msg)
                this.state.collapsedMsgs.push(msg)
                this.state.thread.related = (this.state.thread.related||[]).concat(msg)
                this.setState({
                  thread: this.state.thread,
                  flattenedMsgs: this.state.flattenedMsgs,
                  collapsedMsgs: this.state.collapsedMsgs
                })

                // mark read
                thread.hasUnread = true
                threadlib.markThreadRead(ssb, this.state.thread, err => {
                  if (err)
                    this.context.events.emit('error', explain(err, t('error.markNewReplyRead')))
                })
              }
            })
          )
        }
      })
    })
  }
  componentDidMount() {
    this.constructState(this.props.id)
    this.props.onDidMount && this.props.onDidMount()
  }
  componentWillReceiveProps(newProps) {
    this.constructState(newProps.id)
  }
  componentDidUpdate() {
    this.props.onDidMount && this.props.onDidMount()    
  }
  componentWillUnmount() {
    // abort the livestream
    if (this.liveStream)
      this.liveStream(true, ()=>{})
  }

  getScrollTop() {
    // helper to bring the thread into view
    const container = this.refs.container
    if (!container)
      return false
    return container.offsetTop
  }

  onClose() {
    this.props.onClose && this.props.onClose()
  }

  onShowHistory() {
    this.setState({ isHidingHistory: false })
  }

  onMarkUnread() {
    // mark unread in db
    let thread = this.state.thread
    let keys = this.state.flattenedMsgs
      .filter(m => {
        if (mlib.relationsTo(thread, m).indexOf('root') === -1)
          return false // replies only
        return !m._isRead // mark unread the ones that were unread on expand
      })
      .map(m => m.key)
    keys.push(thread.key)
    this.context.ssb.patchwork.markUnread(keys, err => {
      if (err)
        return this.context.events.emit('error', explain(err, t('error.markUnread')))

      // re-render
      thread.isRead = false
      thread.hasUnread = true
      this.setState(this.state)
      this.props.onMsgChange && this.props.onMsgChange(thread)
    })
  }

  onToggleBookmark(e) {
    e.preventDefault()
    e.stopPropagation()

    // toggle in the DB
    let thread = this.state.thread
    this.context.ssb.patchwork.toggleBookmark(thread.key, (err, isBookmarked) => {
      if (err)
        return this.context.events.emit('error', explain(err, t('error.toggleBookmark')))

      // re-render
      thread.isBookmarked = isBookmarked
      this.setState(this.state)
      this.props.onMsgChange && this.props.onMsgChange(thread)
    })
  }

  onToggleStar(msg) {
    // get current state
    msg.votes = msg.votes || {}
    let oldVote = msg.votes[this.context.user.id]
    let newVote = (oldVote === 1) ? 0 : 1

    // publish new message
    var voteMsg = schemas.vote(msg.key, newVote)
    let done = (err) => {
      if (err)
        return this.context.events.emit('error', explain(err, t('error.publishVote')))

      // re-render
      msg.votes[this.context.user.id] = newVote
      this.setState(this.state)
      this.props.onMsgChange && this.props.onMsgChange(msg)
    }
    if (msg.plaintext)
      this.context.ssb.publish(voteMsg, done)
    else {
      let recps = mlib.links(msg.value.content.recps).map(l => l.link)
      this.context.ssb.private.publish(voteMsg, recps, done)
    }
  }

  onFlag(msg, reason) {
    if (!reason)
      throw new Error('error.flagReasonRequired')

    // publish new message
    const voteMsg = (reason === 'unflag') // special case
      ? schemas.vote(msg.key, 0)
      : schemas.vote(msg.key, -1, reason)
    let done = (err) => {
      if (err)
        return this.context.events.emit('error', explain(err, t('error.publishFlag')))

      // re-render
      msg.votes = msg.votes || {}
      msg.votes[this.context.user.id] = (reason === 'unflag') ? 0 : -1
      this.setState(this.state)
      this.props.onMsgChange && this.props.onMsgChange(msg)
    }
    if (msg.plaintext)
      this.context.ssb.publish(voteMsg, done)
    else {
      let recps = mlib.links(msg.value.content.recps).map(l => l.link)
      this.context.ssb.private.publish(voteMsg, recps, done)
    }
  }

  onSend(msg) {
    if (this.props.onNewReply)
      this.props.onNewReply(msg)
  }

  openMsg(id) {
    this.context.events.emit('open:msg', id)
  }

  onSelectRoot(e) {
    e.preventDefault()
    e.stopPropagation()
    const thread = this.state.thread
    const threadRoot = mlib.link(thread.value.content.root, 'msg')
    this.openMsg(threadRoot.link)
  }

  render() {
    if (this.state.loadError) {
      return <div className="msg-thread not-found" ref="container">
        {t('thread.MessageNotFound')}
      </div>
    }

    const thread = this.state.thread
    const threadRoot = thread && thread.value && mlib.link(thread.value.content.root, 'msg')
    const isViewingReply = !!threadRoot
    const msgs = (this.state.isHidingHistory) ? this.state.collapsedMsgs : this.state.flattenedMsgs
    const canMarkUnread = thread && (thread.isBookmarked || !thread.plaintext)
    const isPublic = (thread && thread.plaintext)
    const authorName = thread && thread.value && u.getName(this.context.users, thread.value.author)
    const channel = thread && thread.value && thread.value.content.channel
    const recps = thread && thread.value && mlib.links(thread.value.content.recps, 'feed')

    return <div className="msg-thread" ref="container">
      { !thread
        ? <div style={{padding: 20, fontWeight: 300, textAlign:'center'}}>{ this.state.isLoading ? t('Loading') : t('thread.NoThreadSelected') }</div>
        : <div>
            <div className="flex thread-toolbar" onClick={this.onClose.bind(this)}>
              <div className="flex-fill">
                { (thread && thread.mentionsUser) ? <i className="fa fa-at"/> : '' }{' '}
                { (thread && thread.plaintext) ? '' : <i className="fa fa-lock"/> }{' '}
                { recps && recps.length
                  ? <span>{t('thread.ToRecps')} <UserLinks ids={recps.map(r => r.link)} /></span>
                  : '' }
                { channel ? <span className="channel">{t('thread.inChannel')} <a href={`#/channel/${channel}`}>#{channel}</a></span> : ''}
              </div>
              { !isViewingReply && thread && isPublic // dont do bookmark btn if this is a private thread (it'll already be in your inbox)
                ? <BookmarkBtn onClick={this.onToggleBookmark.bind(this)} isBookmarked={thread.isBookmarked} />
                : '' }
              { thread
                ? <UnreadBtn onClick={this.onMarkUnread.bind(this)} isUnread={thread.hasUnread} />
                : '' }
            </div>
            <ReactCSSTransitionGroup component="div" className="items" transitionName="fade" transitionAppear={true} transitionAppearTimeout={500} transitionEnterTimeout={500} transitionLeaveTimeout={1}>
              { msgs.map((msg, i) => {
                if (msg.isOldMsgsPlaceholder)
                  return <div key={thread.key+'-oldposts'} className="msg-view card-oldposts" onClick={this.onShowHistory.bind(this)}>{t('thread.numOlderMessages', this.state.numOldMsgsHidden)}</div>

                return <Card
                  key={msg.key}
                  msg={msg}
                  forceRaw={this.props.forceRaw}
                  forceExpanded={(i === 0 && this.props.forceRootExpanded) || isViewingReply || !msg._isRead}
                  onToggleStar={()=>this.onToggleStar(msg)}
                  onFlag={(msg, reason)=>this.onFlag(msg, reason)} />
              }) }
              <div key="composer" className="container"><Composer key={thread.key} thread={thread} suggestOptions={this.props.suggestOptions} channels={this.props.channels} onSend={this.onSend.bind(this)} /></div>
            </ReactCSSTransitionGroup>
          </div>
      }
    </div>
  }
}